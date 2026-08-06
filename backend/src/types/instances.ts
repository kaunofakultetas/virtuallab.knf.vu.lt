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
    profile_id: number | null;
    profile_name: string | null;
}

export type CreateInstanceDTO = {
    profile_id: number;
    template_id: number;
};
