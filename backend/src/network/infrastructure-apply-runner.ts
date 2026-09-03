// -----------------------------------------------------------
//  [*] Network — the VNet apply runner
//
//  Executes a Proxmox VNet reconciliation end to end under
//  the global reconciliation lock: abandon stale running
//  attempts, re-read the plan and pin its revision, observe,
//  plan, refuse when required checks fail for resources the
//  plan will not touch, then persist the attempt and hand it
//  to the apply executor.
//
//  Used by:
//    - provisioning-vnet.ts — per-provisioning VNet step
//    - the access/gateway/trunk runners, which reuse its
//      error types and attempt-store shape
//    - scripts/applyNetworkVnets.ts — the operator CLI
// -----------------------------------------------------------

import { InfrastructurePlan, getInfrastructurePlan } from "./infrastructure-desired-state";
import { applyProxmoxVnetActions, InfrastructureApplyDependencies } from "./infrastructure-apply";
import { observeProxmoxVnets, planProxmoxVnets, ProxmoxVnetObservationClient } from "./adapters/proxmox-vnet";
import {
    ReconciliationAttempt,
    ReconciliationAttemptRepository,
    ReconciliationLockClient,
    ReconciliationPool,
    withReconciliationLock,
} from "./reconciliation-attempts";

export type InfrastructureApplyInput = {
    requestedBy: string;
    expectedRevision: string;
    idempotencyKey?: string;
};

// The plan's revision moved between the caller's read and the lock — the
// caller re-reads and retries rather than applying a stale plan.
export class InfrastructureApplyRevisionError extends Error {
    constructor(
        readonly expectedRevision: string,
        readonly actualRevision: string,
    ) {
        super(`Expected infrastructure revision ${expectedRevision}, received ${actualRevision}`);
        this.name = "InfrastructureApplyRevisionError";
    }
}

export class InfrastructureApplyReadinessError extends Error {
    constructor(readonly failedChecks: string[]) {
        super(`Infrastructure apply is blocked by required checks: ${failedChecks.join(", ")}`);
        this.name = "InfrastructureApplyReadinessError";
    }
}

// The slice of the attempt repository the runner needs — narrowed so tests
// can substitute a store without a database.
export interface InfrastructureApplyAttemptStore {
    abandonRunning(): Promise<number>;
    create(input: {
        requestedBy: string;
        mode: "apply";
        desiredRevision: string;
        idempotencyKey?: string;
    }): Promise<ReconciliationAttempt>;
    checkpoint(
        id: string,
        input: Parameters<ReconciliationAttemptRepository["checkpoint"]>[1],
    ): Promise<ReconciliationAttempt>;
    finish(
        id: string,
        input: Parameters<ReconciliationAttemptRepository["finish"]>[1],
    ): Promise<ReconciliationAttempt>;
}

export type InfrastructureApplyRunnerDependencies = {
    database: Pick<ReconciliationPool, "connect">;
    proxmox: InfrastructureApplyDependencies["proxmox"] & ProxmoxVnetObservationClient;
    getPlan?: (client: ReconciliationLockClient) => Promise<InfrastructurePlan>;
    createAttempts?: (client: ReconciliationLockClient) => InfrastructureApplyAttemptStore;
    convergence?: InfrastructureApplyDependencies["convergence"];
};








// -----------------------------------------------------------
// InfrastructureApplyRunner
// -----------------------------------------------------------
//
// One method, applyVnets — the sequence in the header. A
// required check that fails is only blocking when the plan
// holds no action for that resource: a failing check the
// apply is about to fix must not veto the fix.
//
// Used by:
//   - provisioning-vnet.ts, scripts/applyNetworkVnets.ts
// -----------------------------------------------------------

export class InfrastructureApplyRunner {
    constructor(private readonly dependencies: InfrastructureApplyRunnerDependencies) {}

    async applyVnets(input: InfrastructureApplyInput): Promise<ReconciliationAttempt> {
        return withReconciliationLock(async (client) => {
            const attempts = this.dependencies.createAttempts?.(client)
                ?? new ReconciliationAttemptRepository(client);
            await attempts.abandonRunning();
            const plan = await (this.dependencies.getPlan?.(client) ?? getInfrastructurePlan(client));
            if (input.expectedRevision !== plan.revision) {
                throw new InfrastructureApplyRevisionError(input.expectedRevision, plan.revision);
            }

            const observation = await observeProxmoxVnets(this.dependencies.proxmox);
            const planned = planProxmoxVnets(plan, observation);
            const actionableResources = new Set(planned.actions.map(({ resource }) => resource));
            const blockingChecks = planned.checks.filter((check) => (
                check.required
                && check.status !== "pass"
                && ![...actionableResources].some((resource) => check.key === `proxmox-vnet-${resource}`)
            ));
            if (blockingChecks.length > 0) {
                throw new InfrastructureApplyReadinessError(
                    blockingChecks.map(({ key }) => key).sort(),
                );
            }

            const attempt = await attempts.create({
                requestedBy: input.requestedBy,
                mode: "apply",
                desiredRevision: plan.revision,
                idempotencyKey: input.idempotencyKey,
            });
            await attempts.checkpoint(attempt.id, {
                phase: "planned",
                checks: planned.checks,
                actions: planned.actions,
            });
            const plannedAttempt: ReconciliationAttempt = {
                ...attempt,
                phase: "planned",
                checks: planned.checks,
                actions: planned.actions,
            };
            return applyProxmoxVnetActions(plannedAttempt, {
                attempts,
                proxmox: this.dependencies.proxmox,
                convergence: this.dependencies.convergence,
            });
        }, this.dependencies.database);
    }
}
