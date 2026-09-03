// -----------------------------------------------------------
//  [*] Proxmox — the app-wide client singleton
//
//  One ProxmoxClient built from the PROXMOX_* env vars.
//  Network reconciliation does NOT use this: it builds its
//  own clients from dedicated tokens (proxmox-clients.ts).
//
//  Used by:
//    - controllers, routes and the metrics poller
// -----------------------------------------------------------

import { ProxmoxClient } from "./api";

export const proxmox = new ProxmoxClient({
    baseUrl: process.env.PROXMOX_BASE_URL!,
    nodeName: process.env.PROXMOX_NODE_NAME!,
    authToken: process.env.PROXMOX_AUTH_TOKEN!,
    rejectUnauthorized: process.env.PROXMOX_TLS_INSECURE !== "true",
});
