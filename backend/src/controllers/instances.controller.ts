// -----------------------------------------------------------
//  [*] Controllers — Instances: the instance lifecycle
//
//  Everything an instance goes through: the joined reads
//  (instance + network group + profile), the Proxmox
//  lifecycle calls (create = capacity check → clone →
//  cloud-init config → start → DB insert), the guest-IP
//  wait loop, deletion (Proxmox VM, both Guacamole
//  connections, DB row, then the planned-group cleanup),
//  and the two jobs index.ts schedules: status sync and the
//  expiry sweep. Lifecycle metrics are recorded per op.
//
//  Used by:
//    - instances.route.ts — every endpoint
//    - users.controller.ts — deleting a user's instances
//    - index.ts — fetchAndUpdateStatuses and
//      removeExpiredInstances on their intervals
// -----------------------------------------------------------

import { proxmox } from "@/proxmox";
import { ProxmoxApiError } from "@/proxmox/types";
import { guacamole } from "@/guacamole";
import { Instance } from "@/types/instances";
import { Template } from "@/types/templates";
import { pool } from "@/utils/db";
import { logger } from "@/utils/logger";
import { releaseNetworkGroupAfterInstance } from "@/network/provisioning-teardown";
import { metadata } from "@/utils/metadata";
import { deleteUnusedPlannedGroup } from "@/network/groups";
import {
    AddressSelectionError,
    selectInstanceAddress,
} from "@/network/address-selection";
import {
    assertStorageCapacity,
    getBootDiskStorage,
} from "@/proxmox/storage";
import {
    vlabInstanceCreateDurationSeconds,
    vlabInstanceLifecycleTotal,
    vlabInstancesExpiredRemovedTotal,
} from "@/utils/metrics";


// Thrown by createInstance when the reservation transaction finds the caller
// already at their VM limit. It exists so the route can answer 429 rather than
// 500: the authoritative quota check moved into that transaction, where the
// route can no longer perform it itself.
export class InstanceQuotaExceededError extends Error {
    constructor(public readonly limit: number) {
        super(`VM limit reached (max ${limit} per student)`);
        this.name = "InstanceQuotaExceededError";
    }
}

// How long a reservation may sit unfinished before the expiry sweeper reclaims
// it. Comfortably longer than a clone-and-boot, short enough that a crashed
// provisioning run does not hold a student's quota slot for a whole class.
const RESERVATION_TIMEOUT_MINUTES = 15;

// Proxmox reports an unknown VM as a 500 whose message says "does not exist",
// not as a 404 -- templates.route.ts translates the same shape for the client.
function isProxmoxVmMissing(err: unknown): boolean {
    if (!(err instanceof ProxmoxApiError)) return false;
    const details =
        typeof err.details === "object" && err.details !== null
            ? (err.details as Record<string, unknown>)
            : null;
    const message =
        typeof details?.message === "string" ? details.message.toLowerCase() : "";
    return err.status === 404 || message.includes("does not exist");
}


export const Instances = {
    getAllForUser: async (userId: string): Promise<Instance[]> => {
        const res = await pool.query(
            `SELECT instance.*,
                    network_group.state AS network_group_state,
                    network_group.vlan_tag AS network_group_vlan_tag,
                    network_group.subnet_cidr AS network_group_subnet_cidr,
                    profile.id AS profile_id,
                    profile.name AS profile_name
             FROM instances instance
             LEFT JOIN network_groups network_group ON network_group.id = instance.network_group_id
             LEFT JOIN lab_profiles profile ON profile.id = network_group.profile_id
             WHERE instance.owner_id = $1`,
            [userId],
        );

        return res.rows as Instance[];
    },

    getAll: async (): Promise<Instance[]> => {
        const res = await pool.query(
            `SELECT instance.*,
                    network_group.state AS network_group_state,
                    network_group.vlan_tag AS network_group_vlan_tag,
                    network_group.subnet_cidr AS network_group_subnet_cidr,
                    profile.id AS profile_id,
                    profile.name AS profile_name
             FROM instances instance
             LEFT JOIN network_groups network_group ON network_group.id = instance.network_group_id
             LEFT JOIN lab_profiles profile ON profile.id = network_group.profile_id`,
        );
        return res.rows as Instance[];
    },

    getById: async (instanceId: number): Promise<Instance | null> => {
        const res = await pool.query(
            `SELECT instance.*,
                    network_group.state AS network_group_state,
                    network_group.vlan_tag AS network_group_vlan_tag,
                    network_group.subnet_cidr AS network_group_subnet_cidr,
                    profile.id AS profile_id,
                    profile.name AS profile_name
             FROM instances instance
             LEFT JOIN network_groups network_group ON network_group.id = instance.network_group_id
             LEFT JOIN lab_profiles profile ON profile.id = network_group.profile_id
             WHERE instance.id = $1`,
            [instanceId],
        );
        return res.rows[0] as Instance | null;
    },

    // Every non-loopback IPv4 the guest agent reports, across all interfaces.
    getIPv4: async (proxmoxId: string): Promise<string[] | null> => {
        const ifaceData = await proxmox.getVmNetIfaces(proxmoxId);

        return Object.values(ifaceData)
            .flatMap((iface) => iface["ip-addresses"] ?? [])
            .filter(
                (a) =>
                    a["ip-address-type"] === "ipv4" &&
                    a["ip-address"] !== "127.0.0.1",
            )
            .map((a) => a["ip-address"]);
    },

    // Polls the guest agent until an address inside the instance's network
    // appears (its group's subnet, or the legacy prefix when no allocation
    // exists). "Agent not running" and "VM not running" are transient — the
    // VM is still booting; anything else aborts the wait.
    getInsideNetIPv4: async (proxmoxId: string): Promise<string | null> => {
        const [timeoutMs, intervalMs, ipPrefix, allocation] = await Promise.all([
            metadata.get<number>("settings.instances.ipWaitTimeoutMs"),
            metadata.get<number>("settings.instances.ipPollIntervalMs"),
            metadata.get<string>("settings.network.insideIpPrefix"),
            pool.query<{ subnet_cidr: string }>(
                `SELECT DISTINCT network_group.subnet_cidr
                 FROM instances instance
                 JOIN network_groups network_group
                   ON network_group.id = instance.network_group_id
                 WHERE instance.proxmox_id = $1
                   AND network_group.subnet_cidr IS NOT NULL`,
                [proxmoxId],
            ),
        ]);
        const timeout = timeoutMs ?? 60_000;
        const interval = intervalMs ?? 2_000;
        const prefix = ipPrefix ?? "10.10.";
        // proxmox_id is not unique in the schema, so two subnets for one VMID
        // would leave the owning network ambiguous. Refuse rather than pick one.
        if (allocation.rows.length > 1) {
            throw new AddressSelectionError(
                `VM ${proxmoxId} maps to more than one allocated network group`,
            );
        }
        // A group only carries a subnet once allocated; in legacy and dry-run
        // mode it stays null and selection falls back to the configured prefix.
        const subnetCidr = allocation.rows[0]?.subnet_cidr ?? null;
        const deadline = Date.now() + timeout;

        while (Date.now() < deadline) {
            try {
                const ips = await Instances.getIPv4(proxmoxId);
                const match = selectInstanceAddress(ips ?? [], {
                    subnetCidr,
                    legacyPrefix: prefix,
                });
                if (match) return match;
            } catch (err: any) {
                const msg: string = err?.details?.message ?? err?.message ?? "";
                const isTransient =
                    /guest agent is not running/i.test(msg) ||
                    /vm \d+ is not running/i.test(msg);
                if (!isTransient) throw err;
            }

            const remaining = deadline - Date.now();
            if (remaining <= 0) break;
            await new Promise((r) =>
                setTimeout(r, Math.min(interval, remaining)),
            );
        }

        logger.info("Timed out while getting inside IP");
        return null;
    },

    hasAccessTo: async (
        userId: string,
        instanceId: number,
    ): Promise<boolean> => {
        // userRole must be admin or userId == instance.owner_id
        const res = await pool.query(
            `SELECT EXISTS (
        SELECT 1 FROM users u
        LEFT JOIN instances i ON i.id = $2
        WHERE u.vu_id = $1 AND (
          u.role = 'admin' OR i.owner_id = $1
        )
      ) AS has_access`,
            [userId, instanceId],
        );

        return res.rows[0].has_access === true;
    },

    startInstance: async (instanceId: number): Promise<string> => {
        const instance = await Instances.getById(instanceId);
        if (!instance) throw Error("Instance not found");
        try {
            const upid = await proxmox.startVM(instance.proxmox_id);
            vlabInstanceLifecycleTotal.inc({ op: "start", result: "success" });
            return upid;
        } catch (err) {
            vlabInstanceLifecycleTotal.inc({ op: "start", result: "error" });
            throw err;
        }
    },

    stopInstance: async (instanceId: number): Promise<string> => {
        const instance = await Instances.getById(instanceId);
        if (!instance) throw Error("Instance not found");
        try {
            const upid = await proxmox.stopVM(instance.proxmox_id);
            vlabInstanceLifecycleTotal.inc({ op: "stop", result: "success" });
            return upid;
        } catch (err) {
            vlabInstanceLifecycleTotal.inc({ op: "stop", result: "error" });
            throw err;
        }
    },

    rebootInstance: async (instanceId: number): Promise<string> => {
        const instance = await Instances.getById(instanceId);
        if (!instance) throw Error("Instance not found");
        try {
            const upid = await proxmox.rebootVM(instance.proxmox_id);
            vlabInstanceLifecycleTotal.inc({ op: "reboot", result: "success" });
            return upid;
        } catch (err) {
            vlabInstanceLifecycleTotal.inc({ op: "reboot", result: "error" });
            throw err;
        }
    },

    // The whole birth of an instance, timed end to end: storage capacity
    // check, RESERVE the row, clone, cloud-init config (user = "user",
    // password = the student's vu_id), start, then finalise the row.
    //
    // The row is reserved before the clone, not written after it. Writing it
    // last meant the ~30 s clone was a window in which the caller's quota check
    // read a stale count -- 20 parallel POSTs against a limit of 1 all passed --
    // and in which `markNetworkGroupDeleting`'s "does this group still have
    // instances?" guard could not see a VM that was already being built.
    //
    // The quota is re-checked INSIDE the reservation transaction, under a
    // per-owner advisory lock, which is what actually makes it a limit. The
    // caller's pre-check is only a fast fail.
    //
    // The lock is held for the reservation alone -- milliseconds -- and released
    // before any Proxmox call. It deliberately does not span the clone: the
    // steps around this one check out one or two more pool clients each, and
    // with the default pool size of 10 a 30-second transaction would deadlock
    // the pool under a handful of concurrent creates.
    createInstance: async (
        userId: string,
        template: Template,
        networkGroupId: number,
        bridge: string,
        // null exempts the caller from the per-student limit, matching the
        // route's `req.user.role !== "admin"` pre-check. Passed explicitly
        // rather than re-derived here, so the two checks cannot disagree about
        // who is exempt.
        enforceVmLimit: boolean = true,
    ): Promise<number> => {
        const stopTimer = vlabInstanceCreateDurationSeconds.startTimer();
        let instanceId: number | null = null;
        let clonedVmId: string | null = null;

        try {
            const [minVmId, defaultRuntimeHours, storageReserveBytes, vmLimit] =
                await Promise.all([
                    metadata.get<number>("settings.proxmox.minVmId"),
                    metadata.get<number>("settings.instances.defaultRuntimeHours"),
                    metadata.get<number>("settings.proxmox.storageReserveBytes"),
                    metadata.get<number>("settings.limits.vmPerStudent"),
                ]);
            const templateConfig = await proxmox.getVmConfig(template.proxmox_id);
            const storage = getBootDiskStorage(templateConfig);
            const storageStatus = await proxmox.getNodeStorageStatus(storage);
            assertStorageCapacity(
                storage,
                storageStatus,
                storageReserveBytes ?? 2_147_483_648,
            );
            const newId = await proxmox.getNextAvailableId(minVmId ?? 10_000);

            // --- Reservation: quota + row, atomically -------------------
            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                // Serialises concurrent creates by the same owner and nobody
                // else. hashtext() is stable within a major version, which is
                // all an advisory key needs.
                await client.query(
                    "SELECT pg_advisory_xact_lock(hashtext($1))",
                    [userId],
                );

                const countRes = await client.query<{ count: string }>(
                    `SELECT count(*) AS count FROM instances WHERE owner_id = $1`,
                    [userId],
                );
                const owned = parseInt(countRes.rows[0].count, 10);

                // Fail CLOSED on a malformed limit. metadata.get is a cast, not
                // a parse, so a non-numeric `vmPerStudent` reaches here as-is;
                // comparing against it yields `n >= NaN` -> false, which
                // silently removed the quota for everyone. Falling back to the
                // default is the safe reading of an unusable setting.
                const configured = Number(vmLimit);
                const limit =
                    Number.isFinite(configured) && configured >= 0
                        ? configured
                        : 1;

                if (enforceVmLimit && owned >= limit) {
                    await client.query("ROLLBACK");
                    throw new InstanceQuotaExceededError(limit);
                }

                const sqlResp = await client.query<{ id: number }>(
                    `INSERT INTO instances (
                        owner_id, template_id, proxmox_id, name, run_until,
                        network_group_id, provisioning_started_at
                     )
                     VALUES ($1, $2, $3, $4, NOW() + make_interval(hours => $5), $6, NOW())
                     RETURNING id`,
                    [
                        userId,
                        template.id,
                        newId,
                        template.name,
                        defaultRuntimeHours ?? 3,
                        networkGroupId,
                    ],
                );
                await client.query("COMMIT");
                instanceId = sqlResp.rows[0].id;
            } catch (error) {
                // The quota path has already rolled back; rolling back a
                // finished transaction is a no-op warning, not an error.
                await client.query("ROLLBACK").catch(() => {});
                throw error;
            } finally {
                client.release();
            }
            // --- end reservation ----------------------------------------

            // Clone template -> new id
            const cloneTask = await proxmox.cloneVM(
                template.proxmox_id,
                newId,
                template.name,
            );
            clonedVmId = newId;

            const cloneSuccess = await proxmox.waitForTaskCompletion(cloneTask);

            if (!cloneSuccess) {
                throw Error("Failed to clone VM");
            }

            await proxmox.configVM(newId, {
                ciuser: "user",
                cipassword: userId,
                ipconfig0: "ip=dhcp",
                net0: `virtio,bridge=${bridge},firewall=1`,
                tags: `vm;owner${userId}`,
            });

            const startTask = await proxmox.startVM(newId);
            const startSuccess = await proxmox.waitForTaskCompletion(startTask);
            if (!startSuccess) {
                throw Error("Failed to start VM");
            }

            // The row now describes a real machine.
            await pool.query(
                `UPDATE instances SET provisioning_started_at = NULL WHERE id = $1`,
                [instanceId],
            );

            vlabInstanceLifecycleTotal.inc({
                op: "create",
                result: "success",
            });
            return instanceId;
        } catch (err) {
            vlabInstanceLifecycleTotal.inc({ op: "create", result: "error" });

            // Release the reservation so it stops counting against the quota.
            // Proxmox teardown is best-effort and only attempted if a VM was
            // actually cloned; the row must go either way, and whatever this
            // misses the expiry sweeper reclaims.
            if (clonedVmId) {
                try {
                    // stop first: deleteVM refuses a running guest
                    const stopTask = await proxmox.stopVM(clonedVmId);
                    await proxmox.waitForTaskCompletion(stopTask);
                } catch (stopError) {
                    logger.warn(
                        { err: stopError, vmid: clonedVmId },
                        "Could not stop a half-provisioned VM (may not be running)",
                    );
                }
                try {
                    const deleteTask = await proxmox.deleteVM(clonedVmId);
                    await proxmox.waitForTaskCompletion(deleteTask);
                } catch (cleanupError) {
                    logger.error(
                        { err: cleanupError, vmid: clonedVmId },
                        "Failed to destroy a VM whose provisioning failed",
                    );
                }
            }
            if (instanceId !== null) {
                await pool
                    .query(`DELETE FROM instances WHERE id = $1`, [instanceId])
                    .catch((cleanupError) => {
                        logger.error(
                            { err: cleanupError, instanceId },
                            "Failed to release an instance reservation",
                        );
                    });
            }

            throw err;
        } finally {
            stopTimer();
        }
    },

    // How many live instances still reference a template. Used only to make the
    // 409 from DELETE /templates/:id say what is blocking it.
    countByTemplate: async (templateId: number): Promise<number> => {
        const res = await pool.query<{ count: string }>(
            `SELECT count(*) AS count FROM instances WHERE template_id = $1`,
            [templateId],
        );
        return parseInt(res.rows[0].count, 10);
    },

    // Flags a VM that could not be given its firewall policy AND could not then
    // be destroyed, so it may be running unfiltered on a shared VLAN. The row is
    // kept rather than deleted precisely so somebody can find the machine; the
    // start and session routes refuse it in the meantime.
    markQuarantined: async (instanceId: number): Promise<void> => {
        await pool.query(
            `UPDATE instances SET quarantined = TRUE WHERE id = $1`,
            [instanceId],
        );
        logger.error(
            { instanceId },
            "Quarantined an instance: firewall policy failed and the VM could not be removed",
        );
    },

    deleteInstance: async (instanceId: number): Promise<void> => {
        const instance = await Instances.getById(instanceId);
        if (!instance) throw new Error("Instance not found");

        try {
            // 1. Stop then delete from Proxmox (stop=1 handles running VMs gracefully)
            try {
                const stopTask = await proxmox.stopVM(instance.proxmox_id);
                await proxmox.waitForTaskCompletion(stopTask);
            } catch (err) {
                logger.warn(
                    { err, proxmox_id: instance.proxmox_id },
                    "Could not stop VM before deletion (may already be stopped)",
                );
            }

            try {
                const deleteTask = await proxmox.deleteVM(instance.proxmox_id);
                await proxmox.waitForTaskCompletion(deleteTask);
            } catch (err) {
                // A reservation row can name a VM that was never cloned, and a
                // retried teardown can name one already gone. Neither is a
                // failure to delete -- rethrowing would strand the row, which
                // is exactly what the row is here to avoid.
                if (!isProxmoxVmMissing(err)) throw err;
                logger.warn(
                    { proxmox_id: instance.proxmox_id, instanceId },
                    "VM was already absent from Proxmox; removing its row anyway",
                );
            }

            // 2. Delete Guacamole connections. RDP uses the bare instance id as the
            // name, SSH uses "<id>-ssh" — remove both so neither is orphaned.
            for (const guacName of [String(instanceId), `${instanceId}-ssh`]) {
                try {
                    const conn = await guacamole.getConnectionSummary(guacName);
                    if (conn?.identifier) {
                        await guacamole.deleteConnection(conn.identifier);
                    }
                } catch (err) {
                    logger.warn(
                        { err, instanceId, guacName },
                        "Could not delete Guacamole connection (may not exist)",
                    );
                }
            }

            // 3. Remove from DB
            await pool.query(`DELETE FROM instances WHERE id = $1`, [
                instanceId,
            ]);
            if (instance.network_group_id !== null) {
                await deleteUnusedPlannedGroup(instance.network_group_id);
            }

            vlabInstanceLifecycleTotal.inc({
                op: "delete",
                result: "success",
            });
        } catch (err) {
            vlabInstanceLifecycleTotal.inc({ op: "delete", result: "error" });
            throw err;
        }
    },

    // null = run forever (non-expirable).
    // `maxHoursFromCreation` caps the instance's TOTAL life, measured from
    // created_at rather than from now -- capping the increment instead would
    // still let an unbounded number of renewals accumulate. Pass null to renew
    // without a ceiling (admins), which is the old behaviour.
    updateRuntimeHours: async (
        instanceId: number,
        hoursFromNow: number | null,
        maxHoursFromCreation: number | null = null,
    ) => {
        if (hoursFromNow === null) {
            await pool.query(
                `UPDATE instances SET run_until = NULL WHERE id = $1`,
                [instanceId],
            );
        } else if (maxHoursFromCreation === null) {
            await pool.query(
                `UPDATE instances SET run_until = NOW() + make_interval(hours => $1) WHERE id = $2`,
                [hoursFromNow, instanceId],
            );
        } else {
            // LEAST in SQL, so the ceiling is applied against the row's own
            // created_at in one statement -- no read-modify-write to race.
            await pool.query(
                `UPDATE instances
                    SET run_until = LEAST(
                        NOW() + make_interval(hours => $1),
                        created_at + make_interval(hours => $3)
                    )
                  WHERE id = $2`,
                [hoursFromNow, instanceId, maxHoursFromCreation],
            );
        }
    },

    // Re-enabling expiry keeps an existing deadline (COALESCE) rather than
    // resetting the clock.
    setExpirable: async (instanceId: number, expirable: boolean) => {
        if (expirable) {
            const defaultRuntimeHours =
                (await metadata.get<number>(
                    "settings.instances.defaultRuntimeHours",
                )) ?? 3;
            await pool.query(
                `UPDATE instances
                 SET run_until = COALESCE(run_until, NOW() + make_interval(hours => $2))
                 WHERE id = $1`,
                [instanceId, defaultRuntimeHours],
            );
        } else {
            await pool.query(
                `UPDATE instances SET run_until = NULL WHERE id = $1`,
                [instanceId],
            );
        }
    },

    removeExpiredInstances: async (): Promise<number> => {
        // `network_group_id` is selected here because the row carrying it is
        // what deletion removes, and the sweeper must release a group whose last
        // VM expired just as the user-facing route does.
        //
        // The second clause reclaims abandoned reservations. A row is written
        // before its VM is cloned, so a crash between the two leaves one that
        // describes nothing -- and it counts against its owner's quota until
        // something removes it. `provisioning_started_at` is NULL on every
        // healthy row, so this matches only genuinely stuck ones.
        const res = await pool.query<{ id: number; network_group_id: number | null }>(
            `SELECT id, network_group_id
             FROM instances
             WHERE (run_until IS NOT NULL AND run_until <= NOW())
                OR (provisioning_started_at IS NOT NULL
                    AND provisioning_started_at
                        < NOW() - make_interval(mins => $1))`,
            [RESERVATION_TIMEOUT_MINUTES],
        );

        if (res.rowCount === 0) return 0;

        let deletedCount = 0;

        for (const row of res.rows) {
            try {
                await Instances.deleteInstance(row.id);
                deletedCount += 1;
                // Attributed to the expiry sweeper rather than a user: this
                // deletion had no requester, and a reconciliation attempt needs
                // a real `users.vu_id`, so the group's owner is the honest
                // subject of the change made on their behalf.
                const owner = await pool.query<{ owner_id: string }>(
                    "SELECT owner_id FROM network_groups WHERE id = $1",
                    [row.network_group_id],
                );
                if (owner.rows[0]) {
                    await releaseNetworkGroupAfterInstance(
                        row.network_group_id,
                        owner.rows[0].owner_id,
                    );
                }
            } catch (err) {
                logger.error(
                    { err, instanceId: row.id },
                    "Failed to remove expired instance",
                );
            }
        }

        if (deletedCount > 0) {
            vlabInstancesExpiredRemovedTotal.inc(deletedCount);
        }

        return deletedCount;
    },

    // One bulk UPDATE ... FROM (VALUES ...) carries every VM's status and
    // trimmed data blob to the DB — the 15 s status sync job.
    fetchAndUpdateStatuses: async () => {
        const minVmId =
            (await metadata.get<number>("settings.proxmox.minVmId")) ?? 10_000;
        const vms = (await proxmox.getVms()).filter((vm) => vm.vmid >= minVmId);
        if (vms.length === 0) return;

        const values: string[] = [];
        const placeholders: string[] = [];

        vms.forEach((vm, i) => {
            const base = i * 3;
            placeholders.push(
                `($${base + 1}, $${base + 2}::proxmox_status, $${base + 3}::jsonb)`,
            );

            // Drops these keys from the data written into db
            const {
                cpu,
                mem,
                vmid,
                netin,
                netout,
                serial,
                status,
                memhost,
                pressureiofull,
                pressureiosome,
                pressurecpufull,
                pressurecpusome,
                pressurememoryfull,
                pressurememorysome,
                ...data
            } = vm;

            values.push(vmid.toString(), status, JSON.stringify(data));
        });

        await pool.query(
            `UPDATE instances AS i
             SET status = v.status, data = v.data
             FROM (VALUES ${placeholders.join(", ")})
                  AS v(proxmox_id, status, data)
             WHERE i.proxmox_id = v.proxmox_id`,
            values,
        );
    },
};
