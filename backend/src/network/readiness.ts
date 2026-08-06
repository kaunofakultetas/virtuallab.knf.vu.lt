import { NetworkGroupState } from "@/types/network-groups";
import { pool } from "@/utils/db";
import { getNetworkMode, NetworkMode } from "./mode";

export type NetworkReadinessCheck = {
    key: string;
    ready: boolean;
    detail: string;
};

export type NetworkReadinessReport = {
    mode: NetworkMode;
    ready_for_active: boolean;
    checks: NetworkReadinessCheck[];
    desired_state: {
        profiles: number;
        templates: number;
        groups: Record<NetworkGroupState, number>;
        linked_instances: number;
    };
};

type ReadinessRow = {
    profile_count: string;
    template_count: string;
    default_profile_count: string;
    unassigned_template_count: string;
    allocated_planned_group_count: string;
    invalid_instance_membership_count: string;
    linked_instance_count: string;
    planned_group_count: string;
    creating_group_count: string;
    active_group_count: string;
    deleting_group_count: string;
    error_group_count: string;
};

export async function getNetworkReadiness(): Promise<NetworkReadinessReport> {
    const [mode, result] = await Promise.all([
        getNetworkMode(),
        pool.query<ReadinessRow>(`
            SELECT
                (SELECT count(*) FROM lab_profiles) AS profile_count,
                (SELECT count(*) FROM templates) AS template_count,
                (SELECT count(*) FROM lab_profiles WHERE is_default) AS default_profile_count,
                (SELECT count(*)
                 FROM templates template
                 WHERE NOT EXISTS (
                     SELECT 1
                     FROM lab_profile_templates membership
                     WHERE membership.template_id = template.id
                 )) AS unassigned_template_count,
                (SELECT count(*)
                 FROM network_groups
                 WHERE state = 'planned'
                   AND (vlan_tag IS NOT NULL OR vnet_name IS NOT NULL OR subnet_cidr IS NOT NULL)
                ) AS allocated_planned_group_count,
                (SELECT count(*)
                 FROM instances instance
                 JOIN network_groups network_group ON network_group.id = instance.network_group_id
                 WHERE NOT EXISTS (
                     SELECT 1
                     FROM lab_profile_templates membership
                     WHERE membership.profile_id = network_group.profile_id
                       AND membership.template_id = instance.template_id
                 )) AS invalid_instance_membership_count,
                (SELECT count(*) FROM instances WHERE network_group_id IS NOT NULL) AS linked_instance_count,
                (SELECT count(*) FROM network_groups WHERE state = 'planned') AS planned_group_count,
                (SELECT count(*) FROM network_groups WHERE state = 'creating') AS creating_group_count,
                (SELECT count(*) FROM network_groups WHERE state = 'active') AS active_group_count,
                (SELECT count(*) FROM network_groups WHERE state = 'deleting') AS deleting_group_count,
                (SELECT count(*) FROM network_groups WHERE state = 'error') AS error_group_count
        `),
    ]);
    const row = result.rows[0];

    const checks: NetworkReadinessCheck[] = [
        {
            key: "default-profile",
            ready: Number(row.default_profile_count) === 1,
            detail: `${row.default_profile_count} default profile(s); expected exactly 1`,
        },
        {
            key: "template-membership",
            ready: Number(row.unassigned_template_count) === 0,
            detail: `${row.unassigned_template_count} template(s) have no profile`,
        },
        {
            key: "planned-group-allocation",
            ready: Number(row.allocated_planned_group_count) === 0,
            detail: `${row.allocated_planned_group_count} planned group(s) already have network resources`,
        },
        {
            key: "instance-profile-membership",
            ready: Number(row.invalid_instance_membership_count) === 0,
            detail: `${row.invalid_instance_membership_count} linked instance(s) violate profile/template membership`,
        },
        {
            key: "infrastructure-reconciler",
            ready: false,
            detail: "VLAN/SDN, Gateway, and Access VM reconciliation is not implemented",
        },
    ];

    return {
        mode,
        ready_for_active: checks.every((check) => check.ready),
        checks,
        desired_state: {
            profiles: Number(row.profile_count),
            templates: Number(row.template_count),
            groups: {
                planned: Number(row.planned_group_count),
                creating: Number(row.creating_group_count),
                active: Number(row.active_group_count),
                deleting: Number(row.deleting_group_count),
                error: Number(row.error_group_count),
            },
            linked_instances: Number(row.linked_instance_count),
        },
    };
}