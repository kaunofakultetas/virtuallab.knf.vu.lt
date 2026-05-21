import { proxmox } from "@/proxmox";
import { guacamole } from "@/guacamole";
import { Instance } from "@/types/instances";
import { Template } from "@/types/templates";
import { pool } from "@/utils/db";
import { logger } from "@/utils/logger";
import { metadata } from "@/utils/metadata";

export const Instances = {
    getAllForUser: async (userId: string): Promise<Instance[]> => {
        const res = await pool.query(
            `SELECT * FROM instances WHERE owner_id = $1`,
            [userId],
        );

        return res.rows as Instance[];
    },

    getAll: async (): Promise<Instance[]> => {
        const res = await pool.query(`SELECT * FROM instances`);
        return res.rows as Instance[];
    },

    getById: async (instanceId: number): Promise<Instance | null> => {
        const res = await pool.query(`SELECT * FROM instances WHERE id = $1`, [
            instanceId,
        ]);
        return res.rows[0] as Instance | null;
    },

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

    getInsideNetIPv4: async (proxmoxId: string): Promise<string | null> => {
        const [timeoutMs, intervalMs, ipPrefix] = await Promise.all([
            metadata.get<number>("settings.instances.ipWaitTimeoutMs"),
            metadata.get<number>("settings.instances.ipPollIntervalMs"),
            metadata.get<string>("settings.network.insideIpPrefix"),
        ]);
        const timeout = timeoutMs ?? 60_000;
        const interval = intervalMs ?? 2_000;
        const prefix = ipPrefix ?? "10.10.";
        const deadline = Date.now() + timeout;

        while (Date.now() < deadline) {
            try {
                const ips = await Instances.getIPv4(proxmoxId);
                const match = ips?.find((ip) => ip.startsWith(prefix));
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
        return await proxmox.startVM(instance.proxmox_id);
    },

    stopInstance: async (instanceId: number): Promise<string> => {
        const instance = await Instances.getById(instanceId);
        if (!instance) throw Error("Instance not found");
        return await proxmox.stopVM(instance.proxmox_id);
    },

    rebootInstance: async (instanceId: number): Promise<string> => {
        const instance = await Instances.getById(instanceId);
        if (!instance) throw Error("Instance not found");
        return await proxmox.rebootVM(instance.proxmox_id);
    },

    createInstance: async (
        userId: string,
        template: Template,
    ): Promise<number> => {
        const [minVmId, defaultRuntimeHours] = await Promise.all([
            metadata.get<number>("settings.proxmox.minVmId"),
            metadata.get<number>("settings.instances.defaultRuntimeHours"),
        ]);
        const newId = await proxmox.getNextAvailableId(minVmId ?? 10_000);

        // Clone template -> new id
        const cloneTask = await proxmox.cloneVM(
            template.proxmox_id,
            newId,
            template.name,
        );

        const cloneSuccess = await proxmox.waitForTaskCompletion(cloneTask);

        if (!cloneSuccess) {
            throw Error("Failed to clone VM");
        }

        await proxmox.configVM(newId, {
            ciuser: "user",
            cipassword: userId,
            ipconfig0: "ip=dhcp",
            net0: "virtio,bridge=vmbr20,firewall=1",
            tags: `vm;owner${userId}`,
        });

        const sqlResp = await pool.query(
            `INSERT INTO instances (owner_id, template_id, proxmox_id, name, run_until)
      VALUES ($1, $2, $3, $4, NOW() + make_interval(hours => $5)) RETURNING id`,
            [
                userId,
                template.id,
                newId,
                template.name,
                defaultRuntimeHours ?? 3,
            ],
        );

        proxmox.startVM(newId).then(() => {});

        return sqlResp.rows[0].id;
    },

    deleteInstance: async (instanceId: number): Promise<void> => {
        const instance = await Instances.getById(instanceId);
        if (!instance) throw new Error("Instance not found");

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

        const deleteTask = await proxmox.deleteVM(instance.proxmox_id);
        await proxmox.waitForTaskCompletion(deleteTask);

        // 2. Delete Guacamole connection (connection name == instance id string)
        try {
            const conn = await guacamole.getConnectionSummary(
                String(instanceId),
            );
            if (conn?.identifier) {
                await guacamole.deleteConnection(conn.identifier);
            }
        } catch (err) {
            logger.warn(
                { err, instanceId },
                "Could not delete Guacamole connection (may not exist)",
            );
        }

        // 3. Remove from DB
        await pool.query(`DELETE FROM instances WHERE id = $1`, [instanceId]);
    },

    updateRuntimeHours: async (
        instanceId: number,
        hoursFromNow: number | null,
    ) => {
        if (hoursFromNow === null) {
            await pool.query(
                `UPDATE instances SET run_until = NULL WHERE id = $1`,
                [instanceId],
            );
        } else {
            await pool.query(
                `UPDATE instances SET run_until = NOW() + make_interval(hours => $1) WHERE id = $2`,
                [hoursFromNow, instanceId],
            );
        }
    },

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
        const res = await pool.query<{ id: number }>(
            `SELECT id
             FROM instances
             WHERE run_until IS NOT NULL
               AND run_until <= NOW()`,
        );

        if (res.rowCount === 0) return 0;

        let deletedCount = 0;

        for (const row of res.rows) {
            try {
                await Instances.deleteInstance(row.id);
                deletedCount += 1;
            } catch (err) {
                logger.error(
                    { err, instanceId: row.id },
                    "Failed to remove expired instance",
                );
            }
        }

        return deletedCount;
    },

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
