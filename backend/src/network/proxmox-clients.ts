// -----------------------------------------------------------
//  [*] Network — dedicated Proxmox clients for reconciliation
//
//  Reconciliation never uses the app-wide Proxmox singleton:
//  it builds its own clients from two separate tokens — an
//  observer (read-only) and a mutator (scoped to /sdn, no VM
//  permissions at all). That scoping is what keeps network
//  reconciliation structurally unable to touch guests.
//
//  Callers own the client's lifetime and must close() it.
//
//  Used by:
//    - network.route.ts, readiness.ts, drift-reconciler.ts —
//      the observer
//    - infrastructure-apply-runner.ts — the mutator
//    - scripts/preflightNetworkProxmoxTokens.ts — both
// -----------------------------------------------------------

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
