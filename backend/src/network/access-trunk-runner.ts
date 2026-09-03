// -----------------------------------------------------------
//  [*] Network — the Access trunk apply runner
//
//  Wraps an Access trunk reconciliation in the same audit
//  machinery as every other apply: mode gate (active only),
//  shared reconciliation lock, pinned infrastructure
//  revision, observe-first planning, persisted attempt.
//
//  Used by:
//    - provisioning-network.ts — the trunk step
//    - drift-reconciler.ts — trunk drift repair
//    - scripts/applyAccessTrunk.ts — the operator CLI
//    - test/access-trunk-runner.test.ts
// -----------------------------------------------------------

import { accessTrunkChecks, AccessTrunkPlan, planAccessTrunk } from "./access-trunk";
import {
    applyAccessTrunk,
    AccessTrunkApplyClient,
    AccessTrunkApplyError,
} from "./access-trunk-apply";
import { AccessHostObservation, AccessObservationClient } from "./adapters/access";
import { getInfrastructurePlan, InfrastructurePlan } from "./infrastructure-desired-state";
import { InfrastructureApplyAttemptStore } from "./infrastructure-apply-runner";
import { getNetworkMode, NetworkMode } from "./mode";
import {
    ReconciliationAttempt,
    ReconciliationAttemptRepository,
    ReconciliationLockClient,
    ReconciliationPool,
    withReconciliationLock,
} from "./reconciliation-attempts";
import { ReconciliationAction } from "./reconciliation-types";

export const ACCESS_TRUNK_RESOURCE = "lxc/200/net1-trunks";

export class AccessTrunkModeError extends Error {
    constructor(readonly mode: NetworkMode) {
        super(
            `The Access trunk cannot be reconciled while settings.network.mode is "${mode}". `
            + "Desired membership is derived from operational groups, and no group is "
            + "operational outside active mode, so a reconcile here could only remove "
            + "membership that something else put there.",
        );
        this.name = "AccessTrunkModeError";
    }
}

export class AccessTrunkRevisionError extends Error {
    constructor(readonly expectedRevision: string, readonly actualRevision: string) {
        super(`Expected infrastructure revision ${expectedRevision}, received ${actualRevision}`);
        this.name = "AccessTrunkRevisionError";
    }
}

export class AccessTrunkReadinessError extends Error {
    constructor(readonly failedChecks: string[]) {
        super(`Access trunk reconciliation is blocked by: ${failedChecks.join(", ")}`);
        this.name = "AccessTrunkReadinessError";
    }
}

export type AccessTrunkRunnerDependencies = {
    database: Pick<ReconciliationPool, "connect">;
    apply: AccessTrunkApplyClient;
    observe: AccessObservationClient;
    rollbackSeconds?: number;
    getPlan?: (client: ReconciliationLockClient) => Promise<InfrastructurePlan>;
    createAttempts?: (client: ReconciliationLockClient) => InfrastructureApplyAttemptStore;
    getMode?: () => Promise<NetworkMode>;
};

export type AccessTrunkRunnerInput = {
    requestedBy: string;
    expectedRevision: string;
    idempotencyKey?: string;
};


function trunkAction(
    vlanIds: number[],
    executionState: ReconciliationAction["execution_state"],
): ReconciliationAction {
    return {
        component: "access",
        operation: "update",
        execution_state: executionState,
        resource: ACCESS_TRUNK_RESOURCE,
        desired: { vlan_ids: vlanIds },
    };
}








// -----------------------------------------------------------
// buildAccessTrunkPlan
// -----------------------------------------------------------
//
// Builds the trunk plan from an Access host observation.
//
// Exported because it is the only place the observation's
// shape is mapped onto the planner's, and both the runner
// and its tests need to agree on it.
//
// Used by:
//   - AccessTrunkApplyRunner (below), drift-reconciler.ts
//   - test/access-trunk-runner.test.ts
// -----------------------------------------------------------

export function buildAccessTrunkPlan(
    infrastructure: InfrastructurePlan,
    observation: AccessHostObservation,
): AccessTrunkPlan {
    return planAccessTrunk({
        desired_vlan_ids: infrastructure.desired_state.trunks.access_vlan_ids,
        observed: {
            persistent_vlan_ids: observation.net1.trunks,
            live_veth_present: observation.host_veth.exists,
            live_vlan_ids: observation.host_veth.vlan_ids,
        },
    });
}








// -----------------------------------------------------------
// AccessTrunkApplyRunner
// -----------------------------------------------------------
//
// Reconciles the Access LXC's VLAN trunk and records the
// attempt, so a mutation of hypervisor NIC configuration
// leaves the same audit trail a VNet apply does.
//
// It takes the shared reconciliation advisory lock, which
// means a trunk change can never run concurrently with a
// VNet, Gateway or Access policy apply. That matters
// because all four derive their desired state from the same
// group rows.
//
// Used by:
//   - provisioning-network.ts, drift-reconciler.ts,
//     scripts/applyAccessTrunk.ts
// -----------------------------------------------------------

export class AccessTrunkApplyRunner {
    constructor(private readonly dependencies: AccessTrunkRunnerDependencies) {}

    async apply(input: AccessTrunkRunnerInput): Promise<ReconciliationAttempt> {
        // Refused before the lock is taken, because this is a mode constraint
        // rather than a state check.
        const mode = await (this.dependencies.getMode ?? getNetworkMode)();
        if (mode !== "active") {
            throw new AccessTrunkModeError(mode);
        }
        return withReconciliationLock(async (client) => {
            const attempts = this.dependencies.createAttempts?.(client)
                ?? new ReconciliationAttemptRepository(client);
            await attempts.abandonRunning();

            const infrastructure = await (
                this.dependencies.getPlan?.(client) ?? getInfrastructurePlan(client)
            );
            if (input.expectedRevision !== infrastructure.revision) {
                throw new AccessTrunkRevisionError(input.expectedRevision, infrastructure.revision);
            }

            // Observe before creating an attempt, so a host that cannot be
            // reached at all does not leave a running attempt behind.
            let plan: AccessTrunkPlan;
            try {
                plan = buildAccessTrunkPlan(infrastructure, await this.dependencies.observe.observe());
            } catch (error) {
                throw new AccessTrunkReadinessError([
                    `access-observation (${error instanceof Error ? error.message : "failed"})`,
                ]);
            }

            const checks = accessTrunkChecks(plan);
            // A missing veth is the one condition no trunk write can fix: `pct
            // set` would still succeed and the live half would stay unverifiable,
            // so the apply would report a convergence it never proved.
            if (plan.live.status === "unobservable") {
                throw new AccessTrunkReadinessError(["access-trunk-live"]);
            }

            const attempt = await attempts.create({
                requestedBy: input.requestedBy,
                mode: "apply",
                desiredRevision: infrastructure.revision,
                idempotencyKey: input.idempotencyKey,
            });
            await attempts.checkpoint(attempt.id, {
                phase: "planned",
                checks,
                actions: plan.no_change_required
                    ? []
                    : [trunkAction(plan.desired_vlan_ids, "planned")],
            });

            if (plan.no_change_required) {
                // Recorded as a succeeded apply with no actions rather than
                // skipped entirely: "already converged" and "never asked" are
                // different facts, and only the attempt record can tell them
                // apart later.
                return attempts.finish(attempt.id, {
                    status: "succeeded",
                    phase: "applied",
                    checks,
                    actions: [],
                    appliedRevision: infrastructure.revision,
                });
            }

            await attempts.checkpoint(attempt.id, {
                phase: "applying",
                actions: [trunkAction(plan.desired_vlan_ids, "applying")],
            });

            try {
                await applyAccessTrunk(plan, {
                    apply: this.dependencies.apply,
                    observe: this.dependencies.observe,
                    rollbackSeconds: this.dependencies.rollbackSeconds,
                });
                return await attempts.finish(attempt.id, {
                    status: "succeeded",
                    phase: "applied",
                    checks,
                    actions: [trunkAction(plan.desired_vlan_ids, "succeeded")],
                    appliedRevision: infrastructure.revision,
                });
            } catch (error) {
                const failed = error instanceof AccessTrunkApplyError;
                return await attempts.finish(attempt.id, {
                    status: "failed",
                    phase: "apply-failed",
                    checks,
                    // Every AccessTrunkApplyError leaves the host's timer armed
                    // -- including the commit-stage one, which fires precisely
                    // because the commit failed to cancel it -- so the change is
                    // on its way out and the action is compensated rather than
                    // merely failed. Anything else would imply the trunk was
                    // left holding a half-applied membership.
                    actions: [trunkAction(
                        plan.desired_vlan_ids,
                        failed ? "compensated" : "failed",
                    )],
                    errorCode: failed ? `access-trunk-${error.stage}` : "access-trunk-failed",
                    errorDetail: error instanceof Error ? error.message.slice(0, 1000) : undefined,
                });
            }
        }, this.dependencies.database);
    }
}
