export type NetworkMode = "legacy" | "dry-run" | "active";

export type NetworkCheckStatus = "pass" | "fail" | "unobserved" | "not_applicable";

export interface NetworkReadinessCheck {
    key: string;
    category: string;
    status: NetworkCheckStatus;
    required: boolean;
    detail: string;
}

export interface NetworkReadiness {
    mode: NetworkMode;
    ready_for_active: boolean;
    checks: NetworkReadinessCheck[];
    desired_state: {
        profiles: number;
        templates: number;
        groups: Record<string, number>;
        linked_instances: number;
        projected_groups: number;
        plan_revision: string;
    };
}

export interface NetworkGroupSummary {
    id: number;
    owner_id: string;
    profile_id: number;
    profile_name: string;
    state: "planned" | "creating" | "active" | "deleting" | "error";
    vlan_tag: number | null;
    vnet_name: string | null;
    subnet_cidr: string | null;
    applied_revision: string | null;
    last_error: string | null;
    instance_count: number;
}

export interface GroupPeering {
    group_a_id: number;
    group_b_id: number;
}

export interface ReconciliationAttempt {
    id: string;
    requested_by: string;
    mode: "dry-run" | "apply";
    status: "running" | "succeeded" | "failed" | "abandoned";
    phase: string;
    desired_revision: string;
    applied_revision: string | null;
    checks: { key: string; status: string; required: boolean; detail: string }[];
    actions: { component: string; operation: string; resource: string; execution_state: string }[];
    error_code: string | null;
    error_detail: string | null;
    started_at: string;
    finished_at: string | null;
}
