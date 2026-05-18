import { proxmox } from "@/proxmox";
import { Instance } from "@/types/instances";
import { Template } from "@/types/templates";
import { pool } from "@/utils/db";
import { logger } from "@/utils/logger";

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
        const timeoutMs = 20_000;
        const intervalMs = 2_000;
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            const ips = await Instances.getIPv4(proxmoxId);
            const match = ips?.find((ip) => ip.startsWith("10.10."));
            if (match) return match;

            const remaining = deadline - Date.now();
            if (remaining <= 0) break;
            await new Promise((r) =>
                setTimeout(r, Math.min(intervalMs, remaining)),
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

        return res.rows[0].has_access || true;
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
        const newId = "10000";

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
      VALUES ($1, $2, $3, $4, NOW() + INTERVAL '2 hours') RETURNING id`,
            [userId, template.id, newId, template.name],
        );

        proxmox.startVM(newId).then(() => {});

        return sqlResp.rows[0].id;
    },
};
