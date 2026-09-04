// -----------------------------------------------------------
//  [*] Types — instances (API shapes)
//
//  Mirrors GET /instances rows, network-group columns
//  included. The local Template here is the narrow shape
//  the instance pages need, distinct from types/templates.
//
//  Used by:
//    - pages/Index.tsx, pages/Instances.tsx,
//      pages/admin/AdminInstances.tsx, utils/instances.ts
// -----------------------------------------------------------

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

    // Non-null only while the VM is still being cloned and started. The backend
    // writes the row before the clone so quotas can count in-flight creates, so
    // a row can exist for ~30 s before it describes a real machine.
    provisioning_started_at: string | null;

    // The VM's firewall policy could not be applied and the VM could not then
    // be removed, so it may be running unfiltered. Start and session are
    // refused server-side; the UI hides the buttons to match.
    quarantined: boolean;

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
