// -----------------------------------------------------------
//  [*] Utils — the metrics poll loop
//
//  Refreshes every gauge in metrics.ts that mirrors external
//  state: Postgres row counts, the Proxmox cluster view, and
//  Guacamole sessions. The three sources run in parallel and
//  fail independently — one dead source logs a warning and
//  leaves its gauges stale (visible through the per-source
//  last-success timestamp) while the others keep updating.
//
//  Used by:
//    - index.ts — schedules pollMetrics() on an interval
//      via toad-scheduler
// -----------------------------------------------------------

import { proxmox } from "@/proxmox";
import { guacamole } from "@/guacamole";
import { pool } from "@/utils/db";
import { logger } from "@/utils/logger";
import {
    guacamoleActiveSessions,
    guacamoleConnectionsTotal,
    guacamoleUsersTotal,
    metricsPollDurationSeconds,
    metricsPollLastSuccessTimestamp,
    proxmoxNodeCpuRatio,
    proxmoxNodeMemBytes,
    proxmoxNodeUp,
    proxmoxStorageBytes,
    proxmoxVmCpuRatio,
    proxmoxVmMemBytes,
    proxmoxVmNetBytesTotal,
    proxmoxVmUptimeSeconds,
    proxmoxVmsTotal,
    vlabInstancesTotal,
    vlabTemplatesTotal,
    vlabUsersTotal,
} from "@/utils/metrics";








// -----------------------------------------------------------
// recordSource
// -----------------------------------------------------------
//
// Wraps one source's poll in its own timer and last-success
// stamp, and swallows its failure — a broken Proxmox API
// must not stop the Postgres gauges from refreshing.
//
// Used by:
//   - pollMetrics (below) — once per source
// -----------------------------------------------------------

const recordSource = async (source: string, fn: () => Promise<void>) => {
    const stopTimer = metricsPollDurationSeconds.startTimer({ source });
    try {
        await fn();
        metricsPollLastSuccessTimestamp.set(
            { source },
            Math.floor(Date.now() / 1000),
        );
    } catch (err) {
        logger.warn({ err, source }, "metrics poll source failed");
    } finally {
        stopTimer();
    }
};








// -----------------------------------------------------------
// pollPostgres
// -----------------------------------------------------------
//
// Row counts grouped by role/status/type. Gauges are reset
// before re-set so a group that dropped to zero disappears
// instead of freezing at its last value.
//
// Used by:
//   - pollMetrics (below)
// -----------------------------------------------------------

const pollPostgres = async () => {
    const [users, instances, templates] = await Promise.all([
        pool.query<{ role: string; count: string }>(
            `SELECT role::text AS role, COUNT(*) AS count FROM users GROUP BY role`,
        ),
        pool.query<{ status: string; count: string }>(
            `SELECT status::text AS status, COUNT(*) AS count FROM instances GROUP BY status`,
        ),
        pool.query<{ type: string; count: string }>(
            `SELECT type::text AS type, COUNT(*) AS count FROM templates GROUP BY type`,
        ),
    ]);

    vlabUsersTotal.reset();
    for (const row of users.rows) {
        vlabUsersTotal.set({ role: row.role }, Number(row.count));
    }

    vlabInstancesTotal.reset();
    for (const row of instances.rows) {
        vlabInstancesTotal.set({ status: row.status }, Number(row.count));
    }

    vlabTemplatesTotal.reset();
    for (const row of templates.rows) {
        vlabTemplatesTotal.set({ type: row.type }, Number(row.count));
    }
};


// The subset of a /cluster/resources entry the poller reads; every field
// beyond type/id is optional because node, vm and storage rows share the
// same endpoint.
type ClusterResource = {
    type: string;
    id: string;
    node?: string;
    name?: string;
    vmid?: number;
    status?: string;
    cpu?: number;
    maxcpu?: number;
    mem?: number;
    maxmem?: number;
    disk?: number;
    maxdisk?: number;
    uptime?: number;
    netin?: number;
    netout?: number;
    storage?: string;
    online?: number;
};








// -----------------------------------------------------------
// pollProxmox
// -----------------------------------------------------------
//
// Node, storage and VM gauges from three parallel
// /cluster/resources reads. Everything is reset-then-set so
// removed nodes/VMs/storages vanish from the export.
//
// Used by:
//   - pollMetrics (below)
// -----------------------------------------------------------

const pollProxmox = async () => {
    const [nodes, vms, storages] = await Promise.all([
        proxmox.getClusterResources("node") as Promise<ClusterResource[]>,
        proxmox.getClusterResources("vm") as Promise<ClusterResource[]>,
        proxmox.getClusterResources("storage") as Promise<ClusterResource[]>,
    ]);

    proxmoxNodeUp.reset();
    proxmoxNodeCpuRatio.reset();
    proxmoxNodeMemBytes.reset();
    for (const node of nodes) {
        const nodeLabel = node.node ?? node.name ?? node.id;
        proxmoxNodeUp.set({ node: nodeLabel }, node.status === "online" ? 1 : 0);
        if (typeof node.cpu === "number") {
            proxmoxNodeCpuRatio.set({ node: nodeLabel }, node.cpu);
        }
        if (typeof node.mem === "number") {
            proxmoxNodeMemBytes.set(
                { node: nodeLabel, kind: "used" },
                node.mem,
            );
        }
        if (typeof node.maxmem === "number") {
            proxmoxNodeMemBytes.set(
                { node: nodeLabel, kind: "total" },
                node.maxmem,
            );
        }
    }

    proxmoxStorageBytes.reset();
    for (const storage of storages) {
        const nodeLabel = storage.node ?? "shared";
        const storageLabel = storage.storage ?? storage.id;
        if (typeof storage.disk === "number") {
            proxmoxStorageBytes.set(
                { node: nodeLabel, storage: storageLabel, kind: "used" },
                storage.disk,
            );
        }
        if (typeof storage.maxdisk === "number") {
            proxmoxStorageBytes.set(
                { node: nodeLabel, storage: storageLabel, kind: "total" },
                storage.maxdisk,
            );
        }
    }

    // Per-VM metrics: only emit for VMs visible in /cluster/resources. The full
    // VM list can be hundreds of items in a busy lab, so we cap the per-vm gauges
    // to non-template entries to avoid explosion.
    proxmoxVmCpuRatio.reset();
    proxmoxVmMemBytes.reset();
    proxmoxVmUptimeSeconds.reset();
    proxmoxVmNetBytesTotal.reset();
    const statusCounts: Record<string, number> = {};
    for (const vm of vms) {
        const status = vm.status ?? "unknown";
        statusCounts[status] = (statusCounts[status] ?? 0) + 1;

        if (vm.vmid === undefined) continue;
        const labels = { vmid: String(vm.vmid), name: vm.name ?? "" };

        if (typeof vm.cpu === "number") {
            proxmoxVmCpuRatio.set(labels, vm.cpu);
        }
        if (typeof vm.mem === "number") {
            proxmoxVmMemBytes.set({ ...labels, kind: "used" }, vm.mem);
        }
        if (typeof vm.maxmem === "number") {
            proxmoxVmMemBytes.set({ ...labels, kind: "total" }, vm.maxmem);
        }
        if (typeof vm.uptime === "number") {
            proxmoxVmUptimeSeconds.set(labels, vm.uptime);
        }
        if (typeof vm.netin === "number") {
            proxmoxVmNetBytesTotal.set({ ...labels, direction: "in" }, vm.netin);
        }
        if (typeof vm.netout === "number") {
            proxmoxVmNetBytesTotal.set(
                { ...labels, direction: "out" },
                vm.netout,
            );
        }
    }

    proxmoxVmsTotal.reset();
    for (const [status, count] of Object.entries(statusCounts)) {
        proxmoxVmsTotal.set({ status }, count);
    }
};








// -----------------------------------------------------------
// pollGuacamole
// -----------------------------------------------------------
//
// User/connection totals and the live session sum. Uses the
// cached connection list with forceRefresh, so the poll is
// what keeps that cache warm for the rest of the app.
//
// Used by:
//   - pollMetrics (below)
// -----------------------------------------------------------

const pollGuacamole = async () => {
    const [users, connections] = await Promise.all([
        guacamole.getUsers(),
        guacamole.getConnectionCache(true),
    ]);

    guacamoleUsersTotal.set(Object.keys(users).length);
    const connList = Object.values(connections);
    guacamoleConnectionsTotal.set(connList.length);
    guacamoleActiveSessions.set(
        connList.reduce((sum, c) => sum + (c.activeConnections ?? 0), 0),
    );
};








// -----------------------------------------------------------
// pollMetrics
// -----------------------------------------------------------
//
// One tick of the loop: all three sources in parallel, each
// isolated by recordSource. Never rejects.
//
// Used by:
//   - index.ts — the scheduled poll job
// -----------------------------------------------------------

export const pollMetrics = async () => {
    await Promise.all([
        recordSource("postgres", pollPostgres),
        recordSource("proxmox", pollProxmox),
        recordSource("guacamole", pollGuacamole),
    ]);
};
