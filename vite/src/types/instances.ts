export type ProxmoxStatus = "running" | "stopped" | "suspended" | "unknown";

export interface Instance {
    id: number;
    owner_id: string;
    template_id: number;
    proxmox_id: string;
    name: string;
    status: ProxmoxStatus;
    data: {
        ip_address: string;
    };
    created_at: string;
    run_until: string | null;
    network_group_id: number | null;
    network_group_state: string | null;
    // Null when the instance sits on the shared bridge rather than a reserved
    // per-group VLAN, which is how `legacy` and `dry-run` mode provision.
    network_group_vlan_tag: number | null;
    network_group_subnet_cidr: string | null;
    profile_id: number | null;
    profile_name: string | null;
}

export interface Template {
    id: number;
    name: string;
    type: string;
    proxmox_id: string | number;
    description?: string;
    visible_to_students?: boolean;
}
