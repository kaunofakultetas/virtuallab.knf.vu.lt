export type NetworkGroupState =
    | "planned"
    | "creating"
    | "active"
    | "deleting"
    | "error";

export type NetworkGroup = {
    id: number;
    owner_id: string;
    profile_id: number;
    vlan_tag: number | null;
    vnet_name: string | null;
    subnet_cidr: string | null;
    state: NetworkGroupState;
    desired_revision: string | null;
    applied_revision: string | null;
    last_error: string | null;
    created_at: Date;
    updated_at: Date;
};