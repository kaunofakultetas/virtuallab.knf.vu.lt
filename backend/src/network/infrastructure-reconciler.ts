import { InfrastructurePlan, getInfrastructurePlan } from "./infrastructure-desired-state";
import {
    ReconciliationAttempt,
    ReconciliationAttemptRepository,
    ReconciliationLockClient,
    ReconciliationPool,
    withReconciliationLock,
} from "./reconciliation-attempts";
import {
    observeProxmoxVnets,
    planProxmoxVnets,
    ProxmoxVnetObservationClient,
} from "./adapters/proxmox-vnet";
import { AccessObservationClient, planAccess } from "./adapters/access";
import { ReconciliationDryRun } from "./reconciliation-types";

export type ReconciliationDryRunInput = {
    requestedBy: string;
    expectedRevision?: string;
    idempotencyKey?: string;
};

export class ReconciliationRevisionError extends Error {
    constructor(
        readonly expectedRevision: string,
        readonly actualRevision: string,
    ) {
        super(`Expected infrastructure revision ${expectedRevision}, received ${actualRevision}`);
        this.name = "ReconciliationRevisionError";
    }
}

export interface ReconciliationAttemptStore {
    abandonRunning(): Promise<number>;
    create(input: {
        requestedBy: string;
        mode: "dry-run";
        desiredRevision: string;
        idempotencyKey?: string;
    }): Promise<ReconciliationAttempt>;
    finish(
        id: string,
        input: Parameters<ReconciliationAttemptRepository["finish"]>[1],
    ): Promise<ReconciliationAttempt>;
}

export type InfrastructureReconcilerDependencies = {
    database: Pick<ReconciliationPool, "connect">;
    proxmox: ProxmoxVnetObservationClient;
    access: AccessObservationClient;
    getPlan?: (client: ReconciliationLockClient) => Promise<InfrastructurePlan>;
    createAttempts?: (client: ReconciliationLockClient) => ReconciliationAttemptStore;
};

function sanitizedError(error: unknown): { code: string; detail: string } {
    const rawDetail = error instanceof Error ? error.message : "Unknown reconciliation failure";
    const detail = rawDetail
        .replace(/(authorization|cookie|password|secret|token)\s*[:=]\s*\S+/gi, "$1=[redacted]")
        .replace(/PVEAPIToken=[^\s,;]+/gi, "PVEAPIToken=[redacted]")
        .replace(/PVEAuthCookie=[^\s,;]+/gi, "PVEAuthCookie=[redacted]");
    return {
        code: error instanceof Error && error.name ? error.name : "reconciliation-failed",
        detail: detail.slice(0, 1000),
    };
}

function failedObservation(
    component: "proxmox-vnet" | "access",
    error: unknown,
): ReconciliationDryRun {
    const failure = sanitizedError(error);
    return {
        checks: [{
            key: `${component}-observation`,
            component,
            status: "fail",
            required: true,
            detail: `${component} observation failed: ${failure.detail}`,
        }],
        actions: [],
    };
}

function planComponent<T>(
    component: "proxmox-vnet" | "access",
    result: PromiseSettledResult<T>,
    planner: (observation: T) => ReconciliationDryRun,
): ReconciliationDryRun {
    if (result.status === "rejected") return failedObservation(component, result.reason);
    try {
        return planner(result.value);
    } catch (error) {
        return failedObservation(component, error);
    }
}

export class InfrastructureReconciler {
    constructor(private readonly dependencies: InfrastructureReconcilerDependencies) {}

    async dryRun(input: ReconciliationDryRunInput): Promise<ReconciliationAttempt> {
        return withReconciliationLock(async (client) => {
            const attempts = this.dependencies.createAttempts?.(client)
                ?? new ReconciliationAttemptRepository(client);
            await attempts.abandonRunning();
            const plan = await (this.dependencies.getPlan?.(client) ?? getInfrastructurePlan(client));
            if (input.expectedRevision && input.expectedRevision !== plan.revision) {
                throw new ReconciliationRevisionError(input.expectedRevision, plan.revision);
            }
            const attempt = await attempts.create({
                requestedBy: input.requestedBy,
                mode: "dry-run",
                desiredRevision: plan.revision,
                idempotencyKey: input.idempotencyKey,
            });

            try {
                const [proxmoxResult, accessResult] = await Promise.allSettled([
                    observeProxmoxVnets(this.dependencies.proxmox),
                    this.dependencies.access.observe(),
                ]);
                const components = [
                    planComponent("proxmox-vnet", proxmoxResult, (observation) => (
                        planProxmoxVnets(plan, observation)
                    )),
                    planComponent("access", accessResult, (observation) => (
                        planAccess(plan, observation)
                    )),
                ];
                const checks = components
                    .flatMap(({ checks: componentChecks }) => componentChecks)
                    .sort((left, right) => left.key.localeCompare(right.key));
                const actions = components
                    .flatMap(({ actions: componentActions }) => componentActions)
                    .sort((left, right) => left.resource.localeCompare(right.resource));
                return await attempts.finish(attempt.id, {
                    status: "succeeded",
                    phase: "planned",
                    checks,
                    actions,
                });
            } catch (error) {
                const failure = sanitizedError(error);
                return attempts.finish(attempt.id, {
                    status: "failed",
                    phase: "observation-failed",
                    checks: [],
                    actions: [],
                    errorCode: failure.code,
                    errorDetail: failure.detail,
                });
            }
        }, this.dependencies.database);
    }
}