import { ProxmoxClient } from "./api";

export const proxmox = new ProxmoxClient({
  baseUrl: process.env.PROXMOX_BASE_URL!,
  nodeName: process.env.PROXMOX_NODE_NAME!,
  authToken: process.env.PROXMOX_AUTH_TOKEN!,
  rejectUnauthorized: process.env.PROXMOX_TLS_INSECURE !== "true",
});
