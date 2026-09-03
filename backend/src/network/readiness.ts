// -----------------------------------------------------------
//  [*] Network — the readiness report
//
//  Everything that must be true before the mode switch to
//  "active" is allowed: control-plane invariants from the
//  database, the Proxmox-side observations, the Gateway's
//  recorded runtime settings, datacenter firewall
//  enforcement, and whether the provisioning executors can
//  even be constructed. ready_for_active is simply "every
//  required check passes".
//
//  Used by:
//    - network.route.ts — GET /network/readiness
//    - metadata.route.ts — gating the mode flip to active
// -----------------------------------------------------------

import { NetworkGroupState } from "@/types/network-groups";
import { pool } from "@/utils/db";
import {
    createAccessApplier,
    createAccessObserver,
    createAccessTrunkApplier,
} from "./access-clients";
import { getNetworkPlan } from "./desired-state";
import { createGatewayApplier, createGatewayObserver } from "./gateway-clients";
import { createNetworkProxmoxMutator } from "./proxmox-clients";
import { proxmox } from "@/proxmox";
import { checkVmFirewallEnforcement } from "./vm-firewall-enforcement";
import { GatewayConfigurationError, getGatewayRuntimeSettings } from "./gateway-plan";
import { getNetworkMode, NetworkMode } from "./mode";
import {
    getNetworkObservations,
    NetworkObservation,
    ObservationStatus,
} from "./observations";

export type NetworkReadinessCheck = {
    key: string;
    category: "control-plane" | NetworkObservation["category"];
    status: ObservationStatus;
    required: boolean;
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
        projected_groups: number;
        plan_revision: string;
    };
};

// The one-row invariant sweep below returns counts as strings (pg's bigint).
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








// -----------------------------------------------------------
// checkGatewayRuntimeSettings
// -----------------------------------------------------------
//
// Reports whether the Gateway's guest-specific facts have
// been recorded. These cannot be derived from the database,
// and rendering policy against guessed interface names
// would produce plausible but wrong configuration, so an
// unconfigured Gateway is a required readiness failure
// rather than a default.
//
// Used by:
//   - getNetworkReadiness (below)
// -----------------------------------------------------------

async function checkGatewayRuntimeSettings(): Promise<{
    status: ObservationStatus;
    detail: string;
}> {
    try {
        const settings = await getGatewayRuntimeSettings();
        return {
            status: "pass",
            detail: `Gateway interfaces ${settings.management_interface}/`
                + `${settings.trunk_interface}/${settings.uplink_interface} with `
                + `${settings.upstream_resolvers.length} upstream resolver(s)`,
        };
    } catch (error) {
        return {
            status: "fail",
            detail: error instanceof GatewayConfigurationError
                ? error.message
                : "Gateway runtime settings could not be read",
        };
    }
}








// -----------------------------------------------------------
// checkProvisioningExecutors
// -----------------------------------------------------------
//
// Reports whether the executors provisioning drives can
// actually be built.
//
// Constructing a client opens no connection; it only proves
// the principal, identity file and forced command are
// configured. That is the property worth grading here,
// because a missing channel does not surface until a
// student presses the button: the VNet would be created,
// and then the request would fail with the group already
// allocated and half its infrastructure in place.
//
// The Gateway observer is required despite being optional
// for a dry-run. It is the independent channel an apply
// proves itself through, and committing without that proof
// is the one thing the two-phase design exists to prevent.
//
// Used by:
//   - getNetworkReadiness (below)
// -----------------------------------------------------------

function checkProvisioningExecutors(): { status: ObservationStatus; detail: string } {
    const channels: [string, () => unknown][] = [
        ["proxmox-vnet-mutator", createNetworkProxmoxMutator],
        ["access-observer", createAccessObserver],
        ["access-trunk-applier", createAccessTrunkApplier],
        ["access-applier", createAccessApplier],
        ["gateway-observer", () => {
            const observer = createGatewayObserver();
            if (!observer) throw new Error("not configured");
            return observer;
        }],
        ["gateway-applier", createGatewayApplier],
    ];
    const missing = channels
        .filter(([, create]) => {
            try {
                create();
                return false;
            } catch {
                return true;
            }
        })
        .map(([name]) => name);
    return {
        status: missing.length === 0 ? "pass" : "fail",
        detail: missing.length === 0
            ? `All ${channels.length} provisioning executor channel(s) are configured`
            : `Unconfigured provisioning executor(s): ${missing.join(", ")}`,
    };
}








// -----------------------------------------------------------
// getNetworkReadiness
// -----------------------------------------------------------
//
// Assembles the report: the parallel reads, then the check
// list in a fixed order — control-plane invariants first,
// the Proxmox observations spliced in, the Gateway/firewall
// /executor checks last.
//
// Used by:
//   - network.route.ts, metadata.route.ts
// -----------------------------------------------------------

export async function getNetworkReadiness(): Promise<NetworkReadinessReport> {
    const executors = checkProvisioningExecutors();
    const [mode, result, plan, observations, gatewaySettings, firewall] = await Promise.all([
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
        getNetworkPlan(),
        getNetworkObservations(),
        checkGatewayRuntimeSettings(),
        checkVmFirewallEnforcement(proxmox),
    ]);
    const row = result.rows[0];

    const checks: NetworkReadinessCheck[] = [
        {
            key: "default-profile",
            category: "control-plane",
            status: Number(row.default_profile_count) === 1 ? "pass" : "fail",
            required: true,
            detail: `${row.default_profile_count} default profile(s); expected exactly 1`,
        },
        {
            key: "template-membership",
            category: "control-plane",
            status: Number(row.unassigned_template_count) === 0 ? "pass" : "fail",
            required: true,
            detail: `${row.unassigned_template_count} template(s) have no profile`,
        },
        {
            key: "planned-group-allocation",
            category: "control-plane",
            status: Number(row.allocated_planned_group_count) === 0 ? "pass" : "fail",
            required: true,
            detail: `${row.allocated_planned_group_count} planned group(s) already have network resources`,
        },
        {
            key: "instance-profile-membership",
            category: "control-plane",
            status: Number(row.invalid_instance_membership_count) === 0 ? "pass" : "fail",
            required: true,
            detail: `${row.invalid_instance_membership_count} linked instance(s) violate profile/template membership`,
        },
        {
            key: "desired-state-projection",
            category: "control-plane",
            status: "pass",
            required: true,
            detail: `${plan.desired_state.groups.length} group(s) projected at revision ${plan.revision}`,
        },
        ...observations,
        {
            key: "gateway-runtime-settings",
            category: "control-plane",
            status: gatewaySettings.status,
            required: true,
            detail: gatewaySettings.detail,
        },
        {
            key: "vm-firewall-enforcement",
            category: "control-plane",
            status: firewall.status,
            required: true,
            detail: firewall.detail,
        },
        {
            key: "provisioning-executors",
            category: "control-plane",
            // Replaced the standing `infrastructure-reconciler` blocker once
            // provisioning began driving all four executors per group. It is a
            // real check rather than a constant: the wiring exists, but it is
            // only reachable on a stack whose channels are configured.
            status: executors.status,
            required: true,
            detail: executors.detail,
        },
    ];

    return {
        mode,
        ready_for_active: checks.every(
            (check) => !check.required || check.status === "pass",
        ),
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
            projected_groups: plan.desired_state.groups.length,
            plan_revision: plan.revision,
        },
    };
}
