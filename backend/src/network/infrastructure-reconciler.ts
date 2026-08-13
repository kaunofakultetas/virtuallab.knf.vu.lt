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
import { GatewayObservationClient, planGateway } from "./adapters/gateway";
import { GatewayPlan } from "./gateway-desired-state";
import { getGatewayPlan } from "./gateway-plan";
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
    checkpoint(
        id: string,
        input: Parameters<ReconciliationAttemptRepository["checkpoint"]>[1],
    ): Promise<ReconciliationAttempt>;
    finish(
        id: string,
        input: Parameters<ReconciliationAttemptRepository["finish"]>[1],
    ): Promise<ReconciliationAttempt>;
}

export type InfrastructureReconcilerDependencies = {
    database: Pick<ReconciliationPool, "connect">;
    proxmox: ProxmoxVnetObservationClient;
    access: AccessObservationClient;
    /**
     * Optional, because Gateway observation needs a configured restricted SSH
     * principal that a development stack may not have. When it is absent the
     * dry-run simply reports no Gateway checks; when it is present but fails,
     * the failure is reported as a check rather than discarding the healthy
     * evidence gathered from the other components.
     */
    gateway?: GatewayObservationClient;
    getPlan?: (client: ReconciliationLockClient) => Promise<InfrastructurePlan>;
    getGatewayPlan?: () => Promise<GatewayPlan>;
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
    component: "proxmox-vnet" | "access" | "gateway",
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
    component: "proxmox-vnet" | "access" | "gateway",
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

    /**
     * Gateway desired state is a different document from the infrastructure
     * plan, hashed separately, so it is read here rather than derived from
     * `plan`. Returns null when no observer is configured.
     */
    private async observeGateway(): Promise<
        { plan: GatewayPlan; observation: unknown } | null
    > {
        const client = this.dependencies.gateway;
        if (!client) return null;
        const [gatewayPlan, observation] = await Promise.all([
            (this.dependencies.getGatewayPlan ?? getGatewayPlan)(),
            client.observe(),
        ]);
        return { plan: gatewayPlan, observation };
    }

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
                await attempts.checkpoint(attempt.id, { phase: "planning" });
                const [proxmoxResult, accessResult, gatewayResult] = await Promise.allSettled([
                    observeProxmoxVnets(this.dependencies.proxmox),
                    this.dependencies.access.observe(),
                    this.observeGateway(),
                ]);
                const components = [
                    planComponent("proxmox-vnet", proxmoxResult, (observation) => (
                        planProxmoxVnets(plan, observation)
                    )),
                    planComponent("access", accessResult, (observation) => (
                        planAccess(plan, observation)
                    )),
                    ...(this.dependencies.gateway
                        ? [planComponent("gateway", gatewayResult, (observed) => (
                            observed
                                ? planGateway(observed.plan, observed.observation)
                                : { checks: [], actions: [] }
                        ))]
                        : []),
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