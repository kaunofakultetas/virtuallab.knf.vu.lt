// -----------------------------------------------------------
//  [*] Proxmox — API types
//
//  Shapes of what the Proxmox VE API sends and accepts,
//  grouped to mirror the client's sections: client plumbing,
//  VM listings, guest agent, tasks, node networks, SDN,
//  guest config, and the firewall family. Create/Update
//  variants take booleans where the read shapes carry 0/1 —
//  encodeForm in api.ts does the translation.
//
//  Field names with hyphens ("ip-address") are verbatim API
//  keys; the client's getVms/getVm rewrite hyphens to
//  underscores only where an interface here says so.
//
//  Used by:
//    - proxmox/api.ts and everything that calls it
//    - network/adapters/* — the SDN and firewall shapes
// -----------------------------------------------------------


// -----------------------------------------------------------
// Client plumbing
// -----------------------------------------------------------

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

// Every Proxmox response wraps its payload in { data: ... }.
export interface ProxmoxApiResponse<T> {
    data: T;
}


// -----------------------------------------------------------
// VM listings and status
// -----------------------------------------------------------

export type ProxmoxVMStatus = "running" | "stopped";

// https://pve.proxmox.com/pve-docs/api-viewer/#/nodes/{node}/qemu
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

// https://pve.proxmox.com/pve-docs/api-viewer/#/nodes/{node}/qemu/{vmid}/status/current
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


// -----------------------------------------------------------
// Guest agent — network-get-interfaces
// https://pve.proxmox.com/pve-docs/api-viewer/#/nodes/{node}/qemu/{vmid}/agent/network-get-interfaces
// -----------------------------------------------------------

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


// -----------------------------------------------------------
// Tasks — the UPID every write returns
// -----------------------------------------------------------

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

export interface ProxmoxTaskWaitOptions {
    timeoutMs?: number;
    pollIntervalMs?: number;
}

export class ProxmoxTaskError extends Error {
    constructor(public readonly task: ProxmoxNodeTaskStatus) {
        super(`Proxmox task ${task.upid} failed with status ${task.exitstatus ?? "unknown"}`);
        this.name = "ProxmoxTaskError";
    }
}

export class ProxmoxTaskTimeoutError extends Error {
    constructor(
        public readonly upid: string,
        public readonly timeoutMs: number,
    ) {
        super(`Proxmox task ${upid} did not finish within ${timeoutMs}ms`);
        this.name = "ProxmoxTaskTimeoutError";
    }
}


// -----------------------------------------------------------
// Node networks and SDN
// -----------------------------------------------------------

export interface ProxmoxNodeNetwork {
    iface: string;
    type: string;
    active?: number;
    autostart?: number;
    address?: string;
    cidr?: string;
    bridge_ports?: string;
    bridge_vlan_aware?: number;
    comments?: string;
}

export interface ProxmoxSdnZone {
    zone: string;
    type: string;
    bridge?: string;
    ipam?: string;
}

export interface ProxmoxSdnVnet {
    vnet: string;
    zone: string;
    tag?: number;
    type?: string;
    alias?: string;
    vlanaware?: number;
}

export interface ProxmoxSdnVnetCreate {
    vnet: string;
    zone: string;
    tag?: number;
    alias?: string;
    vlanaware?: boolean;
}

export type ProxmoxSdnVnetUpdate = Partial<Omit<ProxmoxSdnVnetCreate, "vnet">> & {
    digest?: string;
};

export interface ProxmoxSdnSubnet {
    subnet: string;
    vnet: string;
    type?: string;
    gateway?: string;
    snat?: number;
    dhcp_range?: string;
    dhcp_dns_server?: string;
    dns?: string;
}

export interface ProxmoxSdnSubnetCreate {
    subnet: string;
    type?: string;
    gateway?: string;
    snat?: boolean;
    dhcp_range?: string;
    dhcp_dns_server?: string;
    dns?: string;
}

export type ProxmoxSdnSubnetUpdate = Partial<Omit<ProxmoxSdnSubnetCreate, "subnet">> & {
    digest?: string;
};


// -----------------------------------------------------------
// Guest config
// -----------------------------------------------------------

// Only the fields the backend actually writes: NIC strings by index, a
// delete list, and the optimistic-concurrency digest.
export type ProxmoxGuestConfigUpdate = {
    digest?: string;
    delete?: string;
    [networkDevice: `net${number}`]: string | undefined;
};


// -----------------------------------------------------------
// Firewall — rules, security groups, IPSets, options
// -----------------------------------------------------------

export interface ProxmoxFirewallRule {
    pos: number;
    type: "in" | "out" | "group";
    action: string;
    source?: string;
    dest?: string;
    proto?: string;
    sport?: string;
    dport?: string;
    iface?: string;
    enable?: number;
    log?: string;
    comment?: string;
    macro?: string;
    "icmp-type"?: string;
}

export type ProxmoxFirewallRuleInput = Omit<ProxmoxFirewallRule, "pos" | "enable"> & {
    pos?: number;
    enable?: boolean;
    digest?: string;
};

export interface ProxmoxFirewallSecurityGroup {
    group: string;
    comment?: string;
    digest?: string;
}

export interface ProxmoxFirewallSecurityGroupCreate {
    group: string;
    comment?: string;
    digest?: string;
}

export type ProxmoxFirewallSecurityGroupUpdate = Omit<
    ProxmoxFirewallSecurityGroupCreate,
    "group"
>;

export interface ProxmoxFirewallIpSet {
    name: string;
    comment?: string;
    digest?: string;
}

export interface ProxmoxFirewallIpSetCreate {
    name: string;
    comment?: string;
    digest?: string;
}

export interface ProxmoxFirewallIpSetEntry {
    cidr: string;
    comment?: string;
    nomatch?: number;
}

export interface ProxmoxFirewallIpSetEntryInput {
    cidr: string;
    comment?: string;
    nomatch?: boolean;
    digest?: string;
}

export interface ProxmoxFirewallOptions {
    enable?: number;
    dhcp?: number;
    ipfilter?: number;
    // Drops frames whose source MAC is not the one Proxmox assigned the NIC.
    macfilter?: number;
    // IPv6 neighbour discovery. Off means IPv6 cannot establish on the segment.
    ndp?: number;
    // IPv6 router advertisements, which a lab VM must never be able to send.
    radv?: number;
    log_level_in?: string;
    log_level_out?: string;
    policy_in?: string;
    policy_out?: string;
    digest?: string;
}

export interface ProxmoxFirewallOptionsUpdate {
    enable?: boolean;
    dhcp?: boolean;
    ipfilter?: boolean;
    macfilter?: boolean;
    ndp?: boolean;
    radv?: boolean;
    log_level_in?: string;
    log_level_out?: string;
    policy_in?: string;
    policy_out?: string;
    digest?: string;
}


// -----------------------------------------------------------
// Storage
// -----------------------------------------------------------

export interface ProxmoxNodeStorageStatus {
    active: number;
    avail: number;
    enabled: number;
    total: number;
    used: number;
}

export type ProxmoxGuestConfig = Record<string, string | number | boolean | null>;
