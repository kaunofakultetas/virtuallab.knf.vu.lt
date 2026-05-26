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

export const pollMetrics = async () => {
    await Promise.all([
        recordSource("postgres", pollPostgres),
        recordSource("proxmox", pollProxmox),
        recordSource("guacamole", pollGuacamole),
    ]);
};
