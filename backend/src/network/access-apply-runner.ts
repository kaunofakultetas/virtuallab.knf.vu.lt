import {
    AccessApplyClient,
    AccessApplyError,
    AccessApplyPlan,
    applyAccessPolicy,
    buildAccessApplyPlan,
} from "./access-apply";
import { AccessObservationClient, planAccess } from "./adapters/access";
import { getInfrastructurePlan, InfrastructurePlan } from "./infrastructure-desired-state";
import { getNetworkMode, NetworkMode } from "./mode";
import { InfrastructureApplyAttemptStore } from "./infrastructure-apply-runner";
import {
    ReconciliationAttempt,
    ReconciliationAttemptRepository,
    ReconciliationLockClient,
    ReconciliationPool,
    withReconciliationLock,
} from "./reconciliation-attempts";
import { ReconciliationAction, ReconciliationCheck } from "./reconciliation-types";

export const ACCESS_POLICY_RESOURCE = "lxc/200/guest-policy";

export class AccessApplyModeError extends Error {
    constructor(readonly mode: NetworkMode) {
        super(
            `Access policy cannot be applied while settings.network.mode is "${mode}". `
            + "The rendered ruleset permits Guacamole egress to lab VMs over VLAN "
            + "interfaces only, so applying it before the migration to active would "
            + "strand every VM on the untagged legacy transport.",
        );
        this.name = "AccessApplyModeError";
    }
}

export class AccessApplyRevisionError extends Error {
    constructor(readonly expectedRevision: string, readonly actualRevision: string) {
        super(`Expected infrastructure revision ${expectedRevision}, received ${actualRevision}`);
        this.name = "AccessApplyRevisionError";
    }
}

export class AccessApplyReadinessError extends Error {
    constructor(readonly failedChecks: string[]) {
        super(`Access apply is blocked by required checks: ${failedChecks.join(", ")}`);
        this.name = "AccessApplyReadinessError";
    }
}

/**
 * Checks an apply is expected to resolve, so a drifted guest is not blocked from
 * being repaired by the very drift the apply exists to fix.
 *
 * Everything NOT listed here blocks, and that split is deliberate: these four
 * are the checks whose subject is the files the applier rewrites. The persistent
 * and live trunk checks describe hypervisor state, `access-guest-management-address`
 * and `access-guest-legacy-transport-address` describe container configuration,
 * `access-guest-docker-bridges` describes Docker's own networks, and the service
 * binding checks describe whether Guacamole is running. No amount of file
 * writing corrects any of those, so applying over them would only produce a
 * confusing partial success — and the guest itself refuses to commit while its
 * service ports are silent.
 */
export const ACCESS_APPLY_FIXABLE_CHECKS = new Set([
    "access-guest-vlan-interfaces",
    "access-guest-nftables-revision",
    "access-guest-ipv4-forwarding",
    "access-guest-ipv6-disabled",
]);

export type AccessApplyRunnerDependencies = {
    database: Pick<ReconciliationPool, "connect">;
    apply: AccessApplyClient;
    observe: AccessObservationClient;
    rollbackSeconds?: number;
    getPlan?: (client: ReconciliationLockClient) => Promise<InfrastructurePlan>;
    createAttempts?: (client: ReconciliationLockClient) => InfrastructureApplyAttemptStore;
    getMode?: () => Promise<NetworkMode>;
};

export type AccessApplyRunnerInput = {
    requestedBy: string;
    /**
     * The infrastructure revision, not the Access policy revision. The policy
     * revision is a function of the guest's observed Docker bridges, so a caller
     * cannot hold it as a precondition; the infrastructure revision is the one a
     * dry-run publishes.
     */
    expectedRevision: string;
    idempotencyKey?: string;
};

function policyAction(
    revision: string,
    executionState: ReconciliationAction["execution_state"],
): ReconciliationAction {
    return {
        component: "access",
        operation: "update",
        execution_state: executionState,
        resource: ACCESS_POLICY_RESOURCE,
        desired: { revision },
    };
}

/**
 * Applies Access guest policy and records the attempt, so a mutation of LXC 200
 * leaves the same audit trail a VNet apply does.
 *
 * It takes the shared reconciliation advisory lock, which means an Access apply
 * can never run concurrently with a VNet or Gateway apply. That matters because
 * all three derive their desired state from the same group rows.
 */
export class AccessApplyRunner {
    constructor(private readonly dependencies: AccessApplyRunnerDependencies) {}

    async apply(input: AccessApplyRunnerInput): Promise<ReconciliationAttempt> {
        // Refused before the lock is taken, because this is an ordering
        // constraint rather than a state check: the Access ruleset is written
        // for the post-migration world and permits Docker egress to lab subnets
        // over VLAN interfaces only. A legacy VM lives on untagged eth1, so
        // applying while mode is `legacy` breaks the only provisioning path
        // that currently works -- and does so silently, since the apply itself
        // converges and commits.
        const mode = await (this.dependencies.getMode ?? getNetworkMode)();
        if (mode !== "active") {
            throw new AccessApplyModeError(mode);
        }
        return withReconciliationLock(async (client) => {
            const attempts = this.dependencies.createAttempts?.(client)
                ?? new ReconciliationAttemptRepository(client);
            await attempts.abandonRunning();

            const infrastructure = await (
                this.dependencies.getPlan?.(client) ?? getInfrastructurePlan(client)
            );
            if (input.expectedRevision !== infrastructure.revision) {
                throw new AccessApplyRevisionError(input.expectedRevision, infrastructure.revision);
            }

            // Observe before creating an attempt, so a guest that cannot be
            // reached at all does not leave a running attempt behind. The same
            // observation supplies the Docker bridges the policy is rendered
            // against, which is why the plan is built here rather than earlier.
            let plan: AccessApplyPlan;
            let checks: ReconciliationCheck[];
            try {
                const observation = await this.dependencies.observe.observe();
                plan = buildAccessApplyPlan(infrastructure, observation);
                checks = planAccess(infrastructure, observation).checks;
            } catch (error) {
                throw new AccessApplyReadinessError([
                    `access-observation (${error instanceof Error ? error.message : "failed"})`,
                ]);
            }

            const blocking = checks.filter((check) => (
                check.required
                && check.status !== "pass"
                && !ACCESS_APPLY_FIXABLE_CHECKS.has(check.key)
            ));
            if (blocking.length > 0) {
                throw new AccessApplyReadinessError(blocking.map(({ key }) => key).sort());
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
                actions: [policyAction(plan.access.revision, "planned")],
            });
            await attempts.checkpoint(attempt.id, {
                phase: "applying",
                actions: [policyAction(plan.access.revision, "applying")],
            });

            try {
                const result = await applyAccessPolicy(plan, {
                    apply: this.dependencies.apply,
                    observe: this.dependencies.observe,
                    rollbackSeconds: this.dependencies.rollbackSeconds,
                });
                return await attempts.finish(attempt.id, {
                    status: "succeeded",
                    phase: "applied",
                    checks,
                    actions: [policyAction(result.revision, "succeeded")],
                    // The infrastructure revision, so it is comparable with the
                    // attempt's desired revision. The policy revision the guest
                    // now holds is on the action.
                    appliedRevision: infrastructure.revision,
                });
            } catch (error) {
                const failed = error instanceof AccessApplyError;
                return await attempts.finish(attempt.id, {
                    status: "failed",
                    phase: "apply-failed",
                    checks,
                    // The guest either rolled back immediately or will when its
                    // timer fires, so the action is recorded as compensated
                    // rather than merely failed. Anything else would imply the
                    // guest was left holding a half-applied revision.
                    actions: [policyAction(
                        plan.access.revision,
                        failed ? "compensated" : "failed",
                    )],
                    errorCode: failed ? `access-apply-${error.stage}` : "access-apply-failed",
                    errorDetail: error instanceof Error ? error.message.slice(0, 1000) : undefined,
                });
            }
        }, this.dependencies.database);
    }
}
