export type ProxmoxStatus = "running" | "stopped" | "suspended";

export interface InstanceData {
    ip_address: string;
}

export interface Instance {
    id: number;
    owner_id: string;
    template_id: number;
    proxmox_id: string;

    name: string;
    status: ProxmoxStatus;
    data: InstanceData;

    created_at: Date;
    run_until: Date | null;
    network_group_id: number | null;
    network_group_state: string | null;

    // Null whenever the group holds no allocation: an instance provisioned in
    // `legacy` or `dry-run` mode sits on the shared bridge, and its group stays
    // `planned` with no VLAN or subnet of its own.
    network_group_vlan_tag: number | null;
    network_group_subnet_cidr: string | null;
    profile_id: number | null;
    profile_name: string | null;
}

export type CreateInstanceDTO = {
    profile_id: number;
    template_id: number;
};
