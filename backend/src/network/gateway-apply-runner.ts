// -----------------------------------------------------------
//  [*] Network — the Gateway apply runner
//
//  Wraps a Gateway policy apply in the same audit machinery
//  as a VNet apply: shared reconciliation lock, pinned
//  revision, observe-first readiness gating, and a
//  persisted attempt whose action states say what really
//  happened to the guest.
//
//  Used by:
//    - drift-reconciler.ts — repairing Gateway drift
//    - scripts/applyGatewayPolicy.ts — the operator CLI
//    - test/gateway-apply-runner.test.ts
// -----------------------------------------------------------

import { GatewayObservationClient, planGateway } from "./adapters/gateway";
import { GatewayPlan } from "./gateway-desired-state";
import { getGatewayPlan } from "./gateway-plan";
import {
    applyGatewayPolicy,
    GatewayApplyClient,
    GatewayApplyError,
} from "./gateway-apply";
import { InfrastructureApplyAttemptStore } from "./infrastructure-apply-runner";
import {
    ReconciliationAttempt,
    ReconciliationAttemptRepository,
    ReconciliationLockClient,
    ReconciliationPool,
    withReconciliationLock,
} from "./reconciliation-attempts";
import { ReconciliationAction, ReconciliationCheck } from "./reconciliation-types";

export const GATEWAY_POLICY_RESOURCE = "vm/202/guest-policy";

export class GatewayApplyRevisionError extends Error {
    constructor(readonly expectedRevision: string, readonly actualRevision: string) {
        super(`Expected Gateway revision ${expectedRevision}, received ${actualRevision}`);
        this.name = "GatewayApplyRevisionError";
    }
}

export class GatewayApplyReadinessError extends Error {
    constructor(readonly failedChecks: string[]) {
        super(`Gateway apply is blocked by required checks: ${failedChecks.join(", ")}`);
        this.name = "GatewayApplyReadinessError";
    }
}

// Checks an apply is expected to resolve, so a drifted Gateway is not blocked
// from being repaired by the very drift the apply exists to fix.
//
// Everything NOT listed here blocks, and that split is deliberate: these are
// the checks whose subject is guest configuration the applier rewrites. A
// failing `gateway-vm-status`, `gateway-trunk-topology`, `gateway-uplink-connected`,
// `gateway-management-address` or `gateway-default-route` describes hypervisor or
// cloud-init state that no amount of file writing will correct, so applying over
// it would only produce a confusing partial success.
export const GATEWAY_APPLY_FIXABLE_CHECKS = new Set([
    "gateway-nftables-revision",
    "gateway-managed-files",
    "gateway-services",
    "gateway-sysctl",
    "gateway-dns-binding",
    "gateway-vlan-interfaces",
]);

export type GatewayApplyRunnerDependencies = {
    database: Pick<ReconciliationPool, "connect">;
    apply: GatewayApplyClient;
    observe: GatewayObservationClient;
    rollbackSeconds?: number;
    getPlan?: () => Promise<GatewayPlan>;
    createAttempts?: (client: ReconciliationLockClient) => InfrastructureApplyAttemptStore;
};

export type GatewayApplyRunnerInput = {
    requestedBy: string;
    expectedRevision: string;
    idempotencyKey?: string;
};


function policyAction(
    revision: string,
    executionState: ReconciliationAction["execution_state"],
): ReconciliationAction {
    return {
        component: "gateway",
        operation: "update",
        execution_state: executionState,
        resource: GATEWAY_POLICY_RESOURCE,
        desired: { revision },
    };
}








// -----------------------------------------------------------
// GatewayApplyRunner
// -----------------------------------------------------------
//
// Applies Gateway policy and records the attempt, so a
// mutation of the guest leaves the same audit trail a VNet
// apply does.
//
// It takes the shared reconciliation advisory lock, which
// means a Gateway apply and a VNet apply can never run
// concurrently. That matters because both derive their
// desired state from the same group rows.
//
// Used by:
//   - drift-reconciler.ts, scripts/applyGatewayPolicy.ts
// -----------------------------------------------------------

export class GatewayApplyRunner {
    constructor(private readonly dependencies: GatewayApplyRunnerDependencies) {}

    async apply(input: GatewayApplyRunnerInput): Promise<ReconciliationAttempt> {
        return withReconciliationLock(async (client) => {
            const attempts = this.dependencies.createAttempts?.(client)
                ?? new ReconciliationAttemptRepository(client);
            await attempts.abandonRunning();

            const plan = await (this.dependencies.getPlan?.() ?? getGatewayPlan());
            if (input.expectedRevision !== plan.revision) {
                throw new GatewayApplyRevisionError(input.expectedRevision, plan.revision);
            }

            // Observe before creating an attempt, so a guest that cannot be
            // reached at all does not leave a running attempt behind.
            let checks: ReconciliationCheck[];
            try {
                checks = planGateway(plan, await this.dependencies.observe.observe()).checks;
            } catch (error) {
                throw new GatewayApplyReadinessError([
                    `gateway-observation (${error instanceof Error ? error.message : "failed"})`,
                ]);
            }

            const blocking = checks.filter((check) => (
                check.required
                && check.status !== "pass"
                && !GATEWAY_APPLY_FIXABLE_CHECKS.has(check.key)
            ));
            if (blocking.length > 0) {
                throw new GatewayApplyReadinessError(blocking.map(({ key }) => key).sort());
            }

            const attempt = await attempts.create({
                requestedBy: input.requestedBy,
                mode: "apply",
                desiredRevision: plan.revision,
                idempotencyKey: input.idempotencyKey,
            });
            await attempts.checkpoint(attempt.id, {
                phase: "planned",
                checks,
                actions: [policyAction(plan.revision, "planned")],
            });
            await attempts.checkpoint(attempt.id, {
                phase: "applying",
                actions: [policyAction(plan.revision, "applying")],
            });

            try {
                const result = await applyGatewayPolicy(plan, {
                    apply: this.dependencies.apply,
                    observe: this.dependencies.observe,
                    rollbackSeconds: this.dependencies.rollbackSeconds,
                });
                return await attempts.finish(attempt.id, {
                    status: "succeeded",
                    phase: "applied",
                    checks,
                    actions: [policyAction(result.revision, "succeeded")],
                    appliedRevision: result.revision,
                });
            } catch (error) {
                const failed = error instanceof GatewayApplyError;
                return await attempts.finish(attempt.id, {
                    status: "failed",
                    phase: "apply-failed",
                    checks,
                    // The guest either rolled back immediately or will when its
                    // timer fires, so the action is recorded as compensated
                    // rather than merely failed. Anything else would imply the
                    // guest was left holding a half-applied revision.
                    actions: [policyAction(
                        plan.revision,
                        failed ? "compensated" : "failed",
                    )],
                    errorCode: failed ? `gateway-apply-${error.stage}` : "gateway-apply-failed",
                    errorDetail: error instanceof Error ? error.message.slice(0, 1000) : undefined,
                });
            }
        }, this.dependencies.database);
    }
}
