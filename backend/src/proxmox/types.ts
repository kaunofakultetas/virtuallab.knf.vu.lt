export type ProxmoxHTTPMethod = "GET" | "POST" | "DELETE" | "PUT";

export interface ProxmoxClientConfig {
  baseUrl: string;
  nodeName: string;
  authToken: string;
  rejectUnauthorized?: boolean; // Optional: whether to reject unauthorized SSL certificates (default: true)
}

export class ProxmoxApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ProxmoxApiError";
  }
}

export interface ProxmoxApiResponse<T> {
  data: T;
}

export type ProxmoxVMStatus = "running" | "stopped";

/**
 * https://pve.proxmox.com/pve-docs/api-viewer/#/nodes/{node}/qemu
 */
export interface ProxmoxNodeVM {
  vmid: number;
  status: ProxmoxVMStatus;
  cpu: number | null;
  cpus: number | null;
  diskread: number | null;
  diskwrite: number | null;
  lock: string | null;
  maxdisk: number | null;
  maxmem: number | null;
  mem: number | null;
  memhost: number | null;
  name: string | null;
  netin: number | null;
  netout: number | null;
  pid: number | null;
  pressurecpufull: number | null;
  pressurecpusome: number | null;
  pressureiofull: number | null;
  pressureiosome: number | null;
  pressurememoryfull: number | null;
  pressurememorysome: number | null;
  qmpstatus: string | null;
  running_machine: string | null;
  running_qemu: string | null;
  serial: number | null;
  tags: string | null;
  template: number | null;
  uptime: number | null;
}

/**
 * https://pve.proxmox.com/pve-docs/api-viewer/#/nodes/{node}/qemu/{vmid}/status/current
 */
export interface ProxmoxNodeVMStatus {
  vmid: number;
  status: ProxmoxVMStatus;
  ha: Object;
  agent: boolean | null;
  clipboard: any | null;
  cpu: number | null;
  cpus: number | null;
  diskread: number | null;
  diskwrite: number | null;
  lock: string | null;
  maxdisk: number | null;
  maxmem: number | null;
  mem: number | null;
  memhost: number | null;
  name: string | null;
  netin: number | null;
  netout: number | null;
  pid: number | null;
  pressurecpufull: number | null;
  pressurecpusome: number | null;
  pressureiofull: number | null;
  pressureiosome: number | null;
  pressurememoryfull: number | null;
  pressurememorysome: number | null;
  qmpstatus: string | null;
  running_machine: string | null;
  running_qemu: string | null;
  serial: number | null;
  spice: boolean | null;
  tags: string | null;
  template: number | null;
  uptime: number | null;
}

/**
 * https://pve.proxmox.com/pve-docs/api-viewer/#/nodes/{node}/qemu/{vmid}/agent/network-get-interfaces
 */

export interface ProxmoxNodeVMNetIfaceIPAddr {
  "ip-address": string;
  "ip-address-type": "ipv4" | "ipv6";
  prefix: number;
}

export interface ProxmoxNodeVMNetIfaceStatistics {
  "rx-bytes": number;
  "rx-dropped": number;
  "rx-errs": number;
  "rx-packets": number;
  "tx-bytes": number;
  "tx-dropped": number;
  "tx-errs": number;
  "tx-packets": number;
}

export interface ProxmoxNodeVMNetIface {
  name: string;
  "hardware-address": string;
  "ip-addresses": ProxmoxNodeVMNetIfaceIPAddr[];
  statistics: ProxmoxNodeVMNetIfaceStatistics;
}

export interface ProxmoxNodeTaskStatus {
  id: string;
  node: string;
  pid: number;
  pstart: number;
  pstarttime: number;
  status: "running" | "stopped";
  type: string;
  upid: string;
  user: string;
  exitstatus?: string;
}
