import { NetworkGroup } from "@/types/network-groups";
import { pool } from "@/utils/db";
import { AccessApplyRevisionError, AccessApplyRunner } from "./access-apply-runner";
import {
    createAccessApplier,
    createAccessObserver,
    createAccessTrunkApplier,
} from "./access-clients";
import { AccessTrunkApplyRunner, AccessTrunkRevisionError } from "./access-trunk-runner";
import { createGatewayApplier, createGatewayObserver } from "./gateway-clients";
import { GatewayApplyRevisionError, GatewayApplyRunner } from "./gateway-apply-runner";
import { getGatewayPlan } from "./gateway-plan";
import { getInfrastructurePlan } from "./infrastructure-desired-state";
import { ensureNetworkGroupVnet } from "./provisioning-vnet";
import { ReconciliationAttempt } from "./reconciliation-attempts";

export type NetworkProvisioningStepName =
    | "vnet"
    | "access-trunk"
    | "access-policy"
    | "gateway-policy";

export class NetworkProvisioningError extends Error {
    constructor(readonly step: NetworkProvisioningStepName, message: string) {
        super(`Network provisioning failed at ${step}: ${message}`);
        this.name = "NetworkProvisioningError";
    }
}

/**
 * How many times to re-read a plan when a concurrent allocation moves the
 * desired revision between our read and the reconciliation lock. Matches
 * `VNET_APPLY_REVISION_ATTEMPTS`, which solves the same race one layer down.
 */
export const PROVISIONING_REVISION_ATTEMPTS = 3;

export type NetworkProvisioningStep = {
    name: NetworkProvisioningStepName;
    attempt_id: string;
    /** Null when the step converged without changing anything. */
    applied_revision: string | null;
};

export type NetworkProvisioningResult = {
    steps: NetworkProvisioningStep[];
};

export type NetworkProvisioningDependencies = {
    ensureVnet?: (group: NetworkGroup, requestedBy: string) => Promise<ReconciliationAttempt>;
    applyAccessTrunk?: (input: RevisionedApply) => Promise<ReconciliationAttempt>;
    applyAccessPolicy?: (input: RevisionedApply) => Promise<ReconciliationAttempt>;
    applyGatewayPolicy?: (input: RevisionedApply) => Promise<ReconciliationAttempt>;
    infrastructureRevision?: () => Promise<string>;
    gatewayRevision?: () => Promise<string>;
    revisionAttempts?: number;
};

export type RevisionedApply = {
    requestedBy: string;
    expectedRevision: string;
};

/**
 * Runs one revision-guarded step, re-reading the revision when a concurrent
 * allocation invalidates it.
 *
 * Every runner demands an exact desired revision so that an operator can never
 * apply a plan they did not see. That guarantee is worth keeping, but it turns a
 * routine race — two students provisioning at once — into a failed request, so a
 * bounded retry re-reads instead of failing for a conflict that has already
 * resolved itself.
 */
async function runStep(
    name: NetworkProvisioningStepName,
    attempts: number,
    readRevision: () => Promise<string>,
    apply: (expectedRevision: string) => Promise<ReconciliationAttempt>,
    isRevisionConflict: (error: unknown) => boolean,
): Promise<NetworkProvisioningStep> {
    let lastConflict: unknown;
    for (let remaining = attempts; remaining > 0; remaining -= 1) {
        let attempt: ReconciliationAttempt;
        try {
            attempt = await apply(await readRevision());
        } catch (error) {
            if (isRevisionConflict(error)) {
                lastConflict = error;
                continue;
            }
            throw new NetworkProvisioningError(
                name,
                error instanceof Error ? error.message : "unknown failure",
            );
        }
        if (attempt.status !== "succeeded") {
            throw new NetworkProvisioningError(
                name,
                `reconciliation ${attempt.id} finished ${attempt.status}`
                + `${attempt.error_code ? ` (${attempt.error_code})` : ""}`,
            );
        }
        return {
            name,
            attempt_id: attempt.id,
            applied_revision: attempt.applied_revision,
        };
    }
    throw new NetworkProvisioningError(
        name,
        `could not settle on a desired revision after ${attempts} attempts`
        + `${lastConflict instanceof Error ? `: ${lastConflict.message}` : ""}`,
    );
}

function defaultAccessTrunkApply(input: RevisionedApply): Promise<ReconciliationAttempt> {
    return new AccessTrunkApplyRunner({
        database: pool,
        apply: createAccessTrunkApplier(),
        observe: createAccessObserver(),
    }).apply(input);
}

function defaultAccessPolicyApply(input: RevisionedApply): Promise<ReconciliationAttempt> {
    return new AccessApplyRunner({
        database: pool,
        apply: createAccessApplier(),
        observe: createAccessObserver(),
    }).apply(input);
}

function defaultGatewayPolicyApply(input: RevisionedApply): Promise<ReconciliationAttempt> {
    const observe = createGatewayObserver();
    if (!observe) {
        // The observer is optional for a dry-run, which simply reports no
        // Gateway checks. It is not optional here: it is the independent channel
        // an apply proves itself through, and committing without that proof is
        // the one thing the two-phase design exists to prevent.
        throw new Error("Gateway observation is not configured");
    }
    return new GatewayApplyRunner({
        database: pool,
        apply: createGatewayApplier(),
        observe,
    }).apply(input);
}

/**
 * Brings every piece of shared infrastructure in line with an allocated group's
 * desired state, in the only order that leaves no intermediate state broken.
 *
 * 1. **VNet** — the bridge the VM attaches to. Nothing else can be true before
 *    it exists.
 * 2. **Access trunk** — VLAN membership on LXC 200's NIC. It has to precede the
 *    Access policy, because the policy creates a VLAN subinterface on that trunk
 *    and the resulting interface would exist while passing no frames. The Access
 *    policy runner refuses outright in that state, and rightly so.
 * 3. **Access policy** — the VLAN subinterface, its address, and the ruleset
 *    that lets Guacamole reach the new subnet.
 * 4. **Gateway policy** — the VLAN subinterface, DHCP scope, DNS and egress
 *    rules for the new subnet.
 *
 * The Gateway goes last deliberately. A VM that boots before its DHCP scope
 * exists simply retries and gets an address a moment later; an Access guest
 * without trunk membership is silently broken with nothing to retry.
 *
 * Each step reconciles the *whole* desired state rather than this one group, so
 * this converges drift left by earlier failures and is a no-op once everything
 * matches.
 *
 * A failure part-way through is deliberately not unwound. Every step is
 * convergent and idempotent, the group is marked `error` by the caller — which
 * keeps it in the operational plan, allocation intact — and the next apply
 * finishes the job. Tearing down a VNet or a trunk entry here could strip
 * infrastructure a concurrent group depends on.
 */
export async function ensureNetworkGroupInfrastructure(
    group: NetworkGroup,
    requestedBy: string,
    dependencies: NetworkProvisioningDependencies = {},
): Promise<NetworkProvisioningResult> {
    const attempts = dependencies.revisionAttempts ?? PROVISIONING_REVISION_ATTEMPTS;
    const infrastructureRevision = dependencies.infrastructureRevision
        ?? (async () => (await getInfrastructurePlan()).revision);
    const gatewayRevision = dependencies.gatewayRevision
        ?? (async () => (await getGatewayPlan()).revision);
    const ensureVnet = dependencies.ensureVnet ?? ensureNetworkGroupVnet;
    const applyAccessTrunk = dependencies.applyAccessTrunk ?? defaultAccessTrunkApply;
    const applyAccessPolicy = dependencies.applyAccessPolicy ?? defaultAccessPolicyApply;
    const applyGatewayPolicy = dependencies.applyGatewayPolicy ?? defaultGatewayPolicyApply;

    const steps: NetworkProvisioningStep[] = [];

    // The VNet step reads and retries its own revision, because it existed
    // before this orchestrator did and other callers still rely on that.
    let vnet: ReconciliationAttempt;
    try {
        vnet = await ensureVnet(group, requestedBy);
    } catch (error) {
        throw new NetworkProvisioningError(
            "vnet",
            error instanceof Error ? error.message : "unknown failure",
        );
    }
    steps.push({ name: "vnet", attempt_id: vnet.id, applied_revision: vnet.applied_revision });

    steps.push(await runStep(
        "access-trunk",
        attempts,
        infrastructureRevision,
        (expectedRevision) => applyAccessTrunk({ requestedBy, expectedRevision }),
        (error) => error instanceof AccessTrunkRevisionError,
    ));

    steps.push(await runStep(
        "access-policy",
        attempts,
        infrastructureRevision,
        (expectedRevision) => applyAccessPolicy({ requestedBy, expectedRevision }),
        (error) => error instanceof AccessApplyRevisionError,
    ));

    // The Gateway's desired state is a separate document with its own hash, so
    // it is read from its own plan rather than derived from the infrastructure
    // revision the two steps above used.
    steps.push(await runStep(
        "gateway-policy",
        attempts,
        gatewayRevision,
        (expectedRevision) => applyGatewayPolicy({ requestedBy, expectedRevision }),
        (error) => error instanceof GatewayApplyRevisionError,
    ));

    return { steps };
}
