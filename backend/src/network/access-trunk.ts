import z from "zod";

import { ACCESS_MIGRATION_VLAN } from "./infrastructure-desired-state";
import { ReconciliationCheck } from "./reconciliation-types";

// Deliberately floored at 2. VLAN 1 is the untagged/PVID membership carrying the
// legacy eth1 transport on vmbr20, and real `bridge -j vlan show` output contains
// it; only a filter in infra/access/observe_access_forced_command.py strips it
// today. Rejecting it here means a caller that passes unfiltered membership gets
// a loud parse failure instead of a plan that proposes `bridge vlan del vid 1` --
// which would sever the only provisioning path that currently works, and is not
// recoverable by replanning, since the planner would then see it gone and call
// the state converged.
const vlanSchema = z.number().int().min(2).max(4094);

export const accessTrunkObservationSchema = z.object({
    persistent_vlan_ids: z.array(vlanSchema),
    live_veth_present: z.boolean(),
    live_vlan_ids: z.array(vlanSchema),
}).strict();

export const accessTrunkPlanInputSchema = z.object({
    desired_vlan_ids: z.array(vlanSchema),
    observed: accessTrunkObservationSchema,
}).strict();

export type AccessTrunkObservation = z.infer<typeof accessTrunkObservationSchema>;
export type AccessTrunkPlanInput = z.infer<typeof accessTrunkPlanInputSchema>;

export type AccessTrunkPersistentTrunks = {
    status: "satisfied" | "drifted";
    observed_vlan_ids: number[];
    /**
     * The complete trunk list to write, never a partial append: `pct set --net1
     * ...,trunks=<list>` replaces the whole allowlist, so writing anything less
     * than the full desired list silently drops the VLANs left out.
     */
    set_vlan_ids: number[];
};

export type AccessTrunkLiveMembership = {
    status: "satisfied" | "drifted" | "unobservable";
    observed_vlan_ids: number[];
    add_vlan_ids: number[];
    remove_vlan_ids: number[];
};

export type AccessTrunkPlan = {
    desired_vlan_ids: number[];
    persistent: AccessTrunkPersistentTrunks;
    live: AccessTrunkLiveMembership;
    no_change_required: boolean;
};

function canonical(vlanIds: number[]): number[] {
    return [...new Set(vlanIds)].sort((left, right) => left - right);
}

function sameVlans(left: number[], right: number[]): boolean {
    return left.length === right.length && left.every((vlan, index) => vlan === right[index]);
}

/**
 * Plans the two halves of an Access trunk independently.
 *
 * `pct set` only rewrites the container's persistent `trunks=` allowlist; it
 * does not reprogram the bridge VLAN membership of an already-running host-side
 * veth. `bridge vlan add/del` does the opposite: it changes the running veth and
 * is lost on the next container or host restart. `infra/access/stage-access.sh`
 * therefore performs both operations, and the live host has already been
 * observed persistent-correct while live-stale. Collapsing the two into one
 * boolean would let either half hide the other's drift, so each side carries its
 * own status and its own changes.
 */
export class AccessTrunkInvariantError extends Error {}

/**
 * Plans persistent and live trunk membership.
 *
 * Refuses rather than plans when the desired list omits ACCESS_MIGRATION_VLAN.
 * That VLAN carries the Access LXC's only tagged transport, the rest of the
 * codebase force-injects it and grades it as a required check, and a caller can
 * legitimately hand over an empty list (no active groups, a partial read, a
 * plan that has not loaded). Planning a teardown from that would sever tagged
 * transport with no signal, and an all-empty observation would then be blessed
 * as healthy -- the "empty projection silently drops a security property"
 * failure this repository has already hit once.
 */
export function planAccessTrunk(input: unknown): AccessTrunkPlan {
    const parsed = accessTrunkPlanInputSchema.parse(input);
    const desired = canonical(parsed.desired_vlan_ids);
    if (!desired.includes(ACCESS_MIGRATION_VLAN)) {
        throw new AccessTrunkInvariantError(
            `Desired Access trunk omits VLAN ${ACCESS_MIGRATION_VLAN}, which carries the `
            + "Access LXC's tagged transport and is required by access-migration-vlan",
        );
    }
    const persistentObserved = canonical(parsed.observed.persistent_vlan_ids);
    const liveObserved = canonical(parsed.observed.live_vlan_ids);

    const persistent: AccessTrunkPersistentTrunks = {
        status: sameVlans(persistentObserved, desired) ? "satisfied" : "drifted",
        observed_vlan_ids: persistentObserved,
        set_vlan_ids: [...desired],
    };

    // A missing veth cannot be reconciled or even compared, so it is reported as
    // unobservable rather than as an empty membership that happens to need no
    // removals.
    const live: AccessTrunkLiveMembership = parsed.observed.live_veth_present
        ? {
            status: sameVlans(liveObserved, desired) ? "satisfied" : "drifted",
            observed_vlan_ids: liveObserved,
            add_vlan_ids: desired.filter((vlan) => !liveObserved.includes(vlan)),
            remove_vlan_ids: liveObserved.filter((vlan) => !desired.includes(vlan)),
        }
        : {
            status: "unobservable",
            observed_vlan_ids: [],
            add_vlan_ids: [],
            remove_vlan_ids: [],
        };

    return {
        desired_vlan_ids: desired,
        persistent,
        live,
        no_change_required: persistent.status === "satisfied" && live.status === "satisfied",
    };
}

/**
 * Grades a trunk plan for a reconciliation attempt.
 *
 * The two halves are graded separately for the reason `planAccessTrunk`
 * separates them, and the migration VLAN gets its own check so a ruleset that
 * happens to converge on a list missing VLAN 2000 could never read as healthy.
 * `unobservable` is graded `unobserved`, not `fail`: an absent veth is a
 * container that is not running, which is a different problem from a trunk that
 * is wrong.
 */
export function accessTrunkChecks(plan: AccessTrunkPlan): ReconciliationCheck[] {
    const desired = `[${plan.desired_vlan_ids.join(", ")}]`;
    return [
        {
            key: "access-trunk-persistent",
            component: "access",
            status: plan.persistent.status === "satisfied" ? "pass" : "fail",
            required: true,
            detail: `Expected ${desired}, observed [${plan.persistent.observed_vlan_ids.join(", ")}]`,
            observed: plan.persistent.observed_vlan_ids,
        },
        {
            key: "access-trunk-live",
            component: "access",
            status: plan.live.status === "satisfied"
                ? "pass"
                : plan.live.status === "unobservable" ? "unobserved" : "fail",
            required: true,
            detail: plan.live.status === "unobservable"
                ? "The Access host veth is absent, so live membership cannot be compared"
                : `Expected ${desired}, observed [${plan.live.observed_vlan_ids.join(", ")}]`,
            observed: plan.live.observed_vlan_ids,
        },
        {
            key: "access-trunk-migration-vlan",
            component: "access",
            // planAccessTrunk refuses to build a plan without it, so this can
            // only pass. It is emitted anyway: the attempt record is the audit
            // trail, and an invariant that is never written down is one nobody
            // can confirm was held.
            status: plan.desired_vlan_ids.includes(ACCESS_MIGRATION_VLAN) ? "pass" : "fail",
            required: true,
            detail: `VLAN ${ACCESS_MIGRATION_VLAN} carries the Access LXC's tagged transport`,
        },
    ];
}
