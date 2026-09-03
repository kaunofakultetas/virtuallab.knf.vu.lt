// -----------------------------------------------------------
//  [*] Types — network groups
//
//  A network group is one student's isolated lab network:
//  its VLAN tag, VNet and subnet once allocated, its state
//  machine (planned → creating → active → deleting, error
//  from anywhere), and the desired/applied revision pair
//  reconciliation compares. Allocation fields stay null
//  while the group is only planned.
//
//  Used by:
//    - network/groups.ts and the provisioning/teardown flow
// -----------------------------------------------------------

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
