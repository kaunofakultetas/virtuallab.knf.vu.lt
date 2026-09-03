// -----------------------------------------------------------
//  [*] Network — executing VNet actions with compensation
//
//  The executor half of a VNet apply: snapshot the touched
//  VNets, run the mutations, poll until Proxmox observably
//  converges, and on failure restore the snapshot — with
//  the attempt record checkpointed through every phase so
//  the audit trail shows exactly how far things got.
//
//  Used by:
//    - infrastructure-apply-runner.ts — after planning
//    - test/infrastructure-apply.test.ts
// -----------------------------------------------------------

import {
    executeProxmoxVnetActions,
    ProxmoxVnetMutationAction,
    ProxmoxVnetMutationClient,
    ProxmoxVnetObservationClient,
} from "./adapters/proxmox-vnet";
import {
    ReconciliationAttempt,
    ReconciliationAttemptRepository,
} from "./reconciliation-attempts";
import { ReconciliationAction, ReconciliationCheck } from "./reconciliation-types";
import { ProxmoxSdnVnet } from "@/proxmox/types";

export interface InfrastructureApplyAttemptStore {
    checkpoint(
        id: string,
        input: Parameters<ReconciliationAttemptRepository["checkpoint"]>[1],
    ): Promise<ReconciliationAttempt>;
    finish(
        id: string,
        input: Parameters<ReconciliationAttemptRepository["finish"]>[1],
    ): Promise<ReconciliationAttempt>;
}

export type InfrastructureApplyDependencies = {
    attempts: InfrastructureApplyAttemptStore;
    proxmox: ProxmoxVnetMutationClient
        & Pick<ProxmoxVnetObservationClient, "getSdnVnets">
        & { deleteSdnVnet(vnet: string): Promise<void> };
    convergence?: {
        attempts?: number;
        intervalMs?: number;
        sleep?: (milliseconds: number) => Promise<void>;
    };
};

export class ProxmoxVnetConvergenceError extends Error {
    constructor() {
        super("Proxmox VNets did not converge to the desired state");
        this.name = "ProxmoxVnetConvergenceError";
    }
}

export class ProxmoxVnetObservationError extends Error {
    constructor() {
        super("Proxmox VNet convergence observation failed");
        this.name = "ProxmoxVnetObservationError";
    }
}

export class ProxmoxVnetSnapshotError extends Error {
    constructor(detail: string) {
        super(detail);
        this.name = "ProxmoxVnetSnapshotError";
    }
}

export class ProxmoxVnetCompensationError extends Error {
    constructor() {
        super("Proxmox VNet compensation failed");
        this.name = "ProxmoxVnetCompensationError";
    }
}

// What each touched VNet looked like before the apply; null = did not exist.
type VnetSnapshot = Map<string, ProxmoxSdnVnet | null>;


function matches(vnet: ProxmoxSdnVnet | undefined, desired: ProxmoxSdnVnet): boolean {
    return vnet?.vnet === desired.vnet
        && vnet.zone === desired.zone
        && vnet.tag === desired.tag;
}


function convergenceOptions(dependencies: InfrastructureApplyDependencies) {
    const attempts = dependencies.convergence?.attempts ?? 5;
    const intervalMs = dependencies.convergence?.intervalMs ?? 1_000;
    const sleep = dependencies.convergence?.sleep
        ?? ((milliseconds: number) => new Promise<void>((resolve) => {
            setTimeout(resolve, milliseconds);
        }));
    if (!Number.isInteger(attempts) || attempts < 1 || intervalMs < 0) {
        throw new Error("Invalid Proxmox VNet convergence options");
    }
    return { attempts, intervalMs, sleep };
}


async function observeVnets(
    dependencies: InfrastructureApplyDependencies,
): Promise<ProxmoxSdnVnet[]> {
    try {
        return await dependencies.proxmox.getSdnVnets();
    } catch {
        throw new ProxmoxVnetObservationError();
    }
}








// -----------------------------------------------------------
// snapshotVnets
// -----------------------------------------------------------
//
// Captures pre-apply state for compensation, and refuses an
// apply whose actions no longer match reality (a create
// over an existing VNet, an update over a missing one) —
// the plan is stale and must be rebuilt, not forced.
//
// Used by:
//   - applyProxmoxVnetActions (below)
// -----------------------------------------------------------

async function snapshotVnets(
    mutations: ProxmoxVnetMutationAction[],
    dependencies: InfrastructureApplyDependencies,
): Promise<VnetSnapshot> {
    const observedByName = new Map(
        (await observeVnets(dependencies)).map((vnet) => [vnet.vnet, vnet]),
    );
    const snapshot: VnetSnapshot = new Map();
    for (const mutation of mutations) {
        const observed = observedByName.get(mutation.resource) ?? null;
        if (mutation.operation === "create" && observed) {
            throw new ProxmoxVnetSnapshotError(
                `Create action ${mutation.resource} targets a pre-existing VNet`,
            );
        }
        if (mutation.operation === "update" && !observed) {
            throw new ProxmoxVnetSnapshotError(
                `Update action ${mutation.resource} targets a missing VNet`,
            );
        }
        snapshot.set(mutation.resource, observed);
    }
    return snapshot;
}


function convergenceChecks(
    mutations: ProxmoxVnetMutationAction[],
    observedVnets: Awaited<ReturnType<ProxmoxVnetObservationClient["getSdnVnets"]>>,
): ReconciliationCheck[] {
    const observedByName = new Map(observedVnets.map((vnet) => [vnet.vnet, vnet]));
    return mutations.map(({ desired }) => {
        const observed = observedByName.get(desired.vnet);
        const matches = observed?.zone === desired.zone && observed.tag === desired.tag;
        return {
            key: `proxmox-vnet-convergence-${desired.vnet}`,
            component: "proxmox-vnet",
            status: matches ? "pass" : "fail",
            required: true,
            detail: matches
                ? `VNet ${desired.vnet} converged to zone ${desired.zone} and tag ${desired.tag}`
                : `VNet ${desired.vnet} has not converged to zone ${desired.zone} and tag ${desired.tag}`,
            observed,
        };
    });
}








// -----------------------------------------------------------
// compensateVnets
// -----------------------------------------------------------
//
// Restores the snapshot in reverse order — deleting what
// this apply created, putting back what it changed — but
// ONLY where the current state is recognisably this apply's
// work: anything else means a third party wrote in between,
// and overwriting them would compound the damage. Ends by
// polling until the restoration is observable.
//
// Used by:
//   - applyProxmoxVnetActions (below) — on failure
// -----------------------------------------------------------

async function compensateVnets(
    mutations: ProxmoxVnetMutationAction[],
    snapshot: VnetSnapshot,
    dependencies: InfrastructureApplyDependencies,
): Promise<void> {
    const currentByName = new Map(
        (await observeVnets(dependencies)).map((vnet) => [vnet.vnet, vnet]),
    );
    let changed = false;
    for (const mutation of [...mutations].reverse()) {
        const before = snapshot.get(mutation.resource);
        const current = currentByName.get(mutation.resource);
        if (mutation.operation === "create") {
            if (!current) continue;
            if (!matches(current, mutation.desired)) throw new ProxmoxVnetCompensationError();
            await dependencies.proxmox.deleteSdnVnet(mutation.resource);
            changed = true;
            continue;
        }
        if (!before) throw new ProxmoxVnetCompensationError();
        if (matches(current, before)) continue;
        if (!matches(current, mutation.desired)) throw new ProxmoxVnetCompensationError();
        await dependencies.proxmox.updateSdnVnet(before.vnet, {
            zone: before.zone,
            tag: before.tag,
            alias: before.alias,
            vlanaware: before.vlanaware === undefined ? undefined : before.vlanaware === 1,
        });
        changed = true;
    }
    if (changed) {
        const upid = await dependencies.proxmox.applySdnConfiguration();
        if (upid) await dependencies.proxmox.waitForTask(upid);
    }

    const options = convergenceOptions(dependencies);
    for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
        const observedByName = new Map(
            (await observeVnets(dependencies)).map((vnet) => [vnet.vnet, vnet]),
        );
        const restored = mutations.every((mutation) => {
            const before = snapshot.get(mutation.resource);
            const observed = observedByName.get(mutation.resource);
            return before ? matches(observed, before) : observed === undefined;
        });
        if (restored) return;
        if (attempt < options.attempts) await options.sleep(options.intervalMs);
    }
    throw new ProxmoxVnetCompensationError();
}


// Persisted actions arrive as loose JSON; validate the shape before letting
// one anywhere near a mutation.
function toProxmoxVnetMutationAction(action: ReconciliationAction): ProxmoxVnetMutationAction {
    if (action.component !== "proxmox-vnet") {
        throw new Error(`Apply does not support ${action.component} actions`);
    }
    if (action.execution_state !== "planned") {
        throw new Error(`Action ${action.resource} is not in the planned state`);
    }
    if (
        typeof action.desired !== "object"
        || action.desired === null
        || !("vnet" in action.desired)
        || !("zone" in action.desired)
        || !("tag" in action.desired)
        || typeof action.desired.vnet !== "string"
        || typeof action.desired.zone !== "string"
        || typeof action.desired.tag !== "number"
    ) {
        throw new Error(`Action ${action.resource} has an invalid desired VNet`);
    }
    return {
        operation: action.operation,
        resource: action.resource,
        desired: {
            vnet: action.desired.vnet,
            zone: action.desired.zone,
            tag: action.desired.tag,
        },
    };
}








// -----------------------------------------------------------
// applyProxmoxVnetActions
// -----------------------------------------------------------
//
// The full execution: validate actions, snapshot, execute
// with per-action checkpoints, poll convergence (each poll
// rewrites the convergence checks in the attempt), then
// finish. On failure, compensation runs only for mutations
// that actually started; its own success or failure becomes
// a check and the attempt's final phase.
//
// Used by:
//   - infrastructure-apply-runner.ts
// -----------------------------------------------------------

export async function applyProxmoxVnetActions(
    attempt: ReconciliationAttempt,
    dependencies: InfrastructureApplyDependencies,
): Promise<ReconciliationAttempt> {
    if (attempt.mode !== "apply" || attempt.status !== "running") {
        throw new Error(`Attempt ${attempt.id} is not a running apply attempt`);
    }

    const mutations = attempt.actions.map(toProxmoxVnetMutationAction);
    const resources = new Set<string>();
    for (const mutation of mutations) {
        if (resources.has(mutation.resource)) {
            throw new Error(`Attempt ${attempt.id} contains duplicate action ${mutation.resource}`);
        }
        resources.add(mutation.resource);
        if (mutation.resource !== mutation.desired.vnet) {
            throw new Error(`VNet action resource ${mutation.resource} does not match desired VNet`);
        }
    }

    let actions = attempt.actions;
    let checks = attempt.checks;
    let snapshot: VnetSnapshot | undefined;
    try {
        snapshot = await snapshotVnets(mutations, dependencies);
        await executeProxmoxVnetActions(
            dependencies.proxmox,
            mutations,
            async (mutation, executionState) => {
                actions = actions.map((action) => (
                    action.resource === mutation.resource
                        ? { ...action, execution_state: executionState }
                        : action
                ));
                await dependencies.attempts.checkpoint(attempt.id, {
                    phase: "applying",
                    checks: attempt.checks,
                    actions,
                });
            },
            async () => {
                const options = convergenceOptions(dependencies);

                for (let observationAttempt = 1; observationAttempt <= options.attempts; observationAttempt += 1) {
                    const observedVnets = await observeVnets(dependencies);
                    const latestChecks = convergenceChecks(mutations, observedVnets);
                    const convergenceKeys = new Set(latestChecks.map(({ key }) => key));
                    checks = [
                        ...checks.filter(({ key }) => !convergenceKeys.has(key)),
                        ...latestChecks,
                    ].sort((left, right) => left.key.localeCompare(right.key));
                    await dependencies.attempts.checkpoint(attempt.id, {
                        phase: "verifying",
                        checks,
                        actions,
                    });
                    if (latestChecks.every(({ status }) => status === "pass")) return;
                    if (observationAttempt < options.attempts) {
                        await options.sleep(options.intervalMs);
                    }
                }
                throw new ProxmoxVnetConvergenceError();
            },
        );
        return dependencies.attempts.finish(attempt.id, {
            status: "succeeded",
            phase: "applied",
            checks,
            actions,
            appliedRevision: attempt.desired_revision,
        });
    } catch (error) {
        const originalErrorCode = error instanceof Error ? error.name : "apply-failed";
        const startedMutations = mutations.filter(({ resource }) => (
            actions.find((action) => action.resource === resource)?.execution_state === "failed"
        ));
        if (snapshot && startedMutations.length > 0) {
            try {
                await dependencies.attempts.checkpoint(attempt.id, {
                    phase: "compensating",
                    checks,
                    actions,
                });
                await compensateVnets(startedMutations, snapshot, dependencies);
                actions = actions.map((action) => (
                    startedMutations.some(({ resource }) => resource === action.resource)
                        ? { ...action, execution_state: "compensated" }
                        : action
                ));
                const compensationCheck: ReconciliationCheck = {
                    key: "proxmox-vnet-compensation",
                    component: "proxmox-vnet",
                    status: "pass",
                    required: true,
                    detail: "Proxmox VNet pre-apply state was restored",
                };
                checks = [
                    ...checks.filter(({ key }) => key !== "proxmox-vnet-compensation"),
                    compensationCheck,
                ].sort((left, right) => left.key.localeCompare(right.key));
                await dependencies.attempts.checkpoint(attempt.id, {
                    phase: "compensated",
                    checks,
                    actions,
                });
                return dependencies.attempts.finish(attempt.id, {
                    status: "failed",
                    phase: "compensated",
                    checks,
                    actions,
                    errorCode: originalErrorCode,
                    errorDetail: "Proxmox VNet apply failed; compensation succeeded",
                });
            } catch {
                const compensationCheck: ReconciliationCheck = {
                    key: "proxmox-vnet-compensation",
                    component: "proxmox-vnet",
                    status: "fail",
                    required: true,
                    detail: "Proxmox VNet compensation failed",
                };
                checks = [
                    ...checks.filter(({ key }) => key !== "proxmox-vnet-compensation"),
                    compensationCheck,
                ].sort((left, right) => left.key.localeCompare(right.key));
                return dependencies.attempts.finish(attempt.id, {
                    status: "failed",
                    phase: "compensation-failed",
                    checks,
                    actions,
                    errorCode: originalErrorCode,
                    errorDetail: "Proxmox VNet apply failed; compensation also failed",
                });
            }
        }
        return dependencies.attempts.finish(attempt.id, {
            status: "failed",
            phase: "apply-failed",
            checks,
            actions,
            errorCode: originalErrorCode,
            errorDetail: "Proxmox VNet apply failed",
        });
    }
}
