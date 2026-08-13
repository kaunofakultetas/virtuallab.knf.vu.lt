import { ProxmoxClient } from "@/proxmox/api";
import { z } from "zod";

const sharedConfigSchema = z.object({
    PROXMOX_BASE_URL: z.string().url(),
    PROXMOX_NODE_NAME: z.string().min(1),
    PROXMOX_TLS_INSECURE: z.enum(["true", "false"]).optional(),
});

function createNetworkProxmoxClient(tokenVariable: string): ProxmoxClient {
    const shared = sharedConfigSchema.safeParse(process.env);
    const authToken = process.env[tokenVariable]?.trim();
    if (!shared.success || !authToken) {
        throw new Error(`Network Proxmox client is missing ${tokenVariable} or shared configuration`);
    }
    return new ProxmoxClient({
        baseUrl: shared.data.PROXMOX_BASE_URL,
        nodeName: shared.data.PROXMOX_NODE_NAME,
        authToken,
        rejectUnauthorized: shared.data.PROXMOX_TLS_INSECURE !== "true",
    });
}

export function createNetworkProxmoxObserver(): ProxmoxClient {
    return createNetworkProxmoxClient("PROXMOX_NETWORK_OBSERVER_AUTH_TOKEN");
}

export function createNetworkProxmoxMutator(): ProxmoxClient {
    return createNetworkProxmoxClient("PROXMOX_NETWORK_MUTATOR_AUTH_TOKEN");
}