// -----------------------------------------------------------
//  [*] Types — instances
//
//  The instance row as the API serves it: the DB columns
//  plus the network-group columns the instance queries join
//  in. `proxmox_id` is a string here even though Proxmox
//  VMIDs are numeric — it comes straight from the DB column.
//
//  Used by:
//    - instances.controller.ts, instances.route.ts
// -----------------------------------------------------------

export type ProxmoxStatus = "running" | "stopped" | "suspended";

// The JSONB `data` column; the guest IP lands here once observed.
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

    // Non-NULL only while the VM is being cloned and started. The row is
    // written before the clone so quotas and the network state machine can see
    // an in-flight create; this is what distinguishes a reservation from a
    // finished instance.
    provisioning_started_at: Date | null;

    // The VM could not be given its firewall policy and could not then be
    // destroyed, so it may be running unfiltered. Start and session refuse it.
    quarantined: boolean;

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
