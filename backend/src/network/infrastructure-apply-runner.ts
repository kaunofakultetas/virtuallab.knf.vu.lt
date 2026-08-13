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