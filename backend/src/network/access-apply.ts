// -----------------------------------------------------------
//  [*] Network — the two-phase Access policy apply
//
//  Stage → prove → commit against LXC 200's guest applier —
//  the Access twin of gateway-apply.ts. The guest arms a
//  rollback timer before installing anything, so every
//  failure path is safe to abandon: not committing is
//  itself the recovery. The pre-commit proof runs over the
//  read-only observer principal, never the session that
//  made the change.
//
//  Split into (executor last):
//
//    ACCESS_ROLLBACK_SECONDS       — default timer window
//    AccessApplyError              — staged failures
//    response schemas              — the guest's answers
//    RestrictedSshAccessApplyClient — the SSH channel
//    buildAccessApplyPlan          — infra plan + observation
//    renderedAccessFiles           — the path contract
//    applyAccessPolicy             — the flow itself
//    abandon                       — best-effort rollback
//
//  Used by:
//    - access-apply-runner.ts — the audited entry point
//    - access-clients.ts — constructs the SSH client
//    - test/access-apply.test.ts
// -----------------------------------------------------------

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AccessPlan, buildOperationalAccessPlan } from "./access-desired-state";
import { renderAccessConfiguration } from "./access-render";
import {
    AccessHostObservation,
    AccessObservationClient,
    planAccess,
} from "./adapters/access";
import { RestrictedSshTransport } from "./adapters/restricted-ssh";
import { InfrastructurePlan } from "./infrastructure-desired-state";

// Default window between staging and committing. Long enough for an independent
// observation over a fresh connection, short enough that a broken ruleset keeps
// students out for minutes rather than until someone notices. The guest clamps
// this to its own bounds.
export const ACCESS_ROLLBACK_SECONDS = 300;

export class AccessApplyError extends Error {
    // Whether the immediate rollback succeeded; undefined if none was attempted.
    rolledBack?: boolean;

    constructor(
        message: string,
        readonly stage: "stage" | "verify" | "commit",
        readonly transactionId?: string,
    ) {
        super(message);
        this.name = "AccessApplyError";
    }
}

const verificationSchema = z.object({
    observed_revision: z.string().nullable(),
    revision_matches: z.boolean(),
    // Reported as strings because the guest matches them against `ss` output.
    service_ports_listening: z.array(z.string()),
    converged: z.boolean(),
});

export const accessStageResponseSchema = z.object({
    version: z.literal(1),
    request_id: z.uuid(),
    target: z.literal("access"),
    operation: z.literal("stage"),
    transaction_id: z.string().min(1),
    revision: z.string().regex(/^[0-9a-f]{64}$/),
    validators: z.array(z.string()),
    // Managed VLAN paths removed because desired state no longer wants them. A
    // released group's files are invisible to the renderer, so pruning is the
    // only way an apply converges back to fewer interfaces.
    pruned: z.array(z.string()),
    reloaded: z.array(z.string()),
    // True only for the transaction that first taught /etc/nftables.conf to load
    // /etc/nftables.d, which is what an earlier hand-apply forgot.
    nftables_include_added: z.boolean(),
    verification: verificationSchema,
    rollback_armed: z.boolean(),
    rollback_seconds: z.number().int(),
});

export const accessCommitResponseSchema = z.object({
    version: z.literal(1),
    request_id: z.uuid(),
    target: z.literal("access"),
    operation: z.literal("commit"),
    transaction_id: z.string().min(1),
    revision: z.string(),
    committed: z.literal(true),
    rollback_armed: z.boolean(),
    verification: verificationSchema,
});

export type AccessStageResponse = z.infer<typeof accessStageResponseSchema>;
export type AccessCommitResponse = z.infer<typeof accessCommitResponseSchema>;

export interface AccessApplyClient {
    stage(input: {
        revision: string;
        files: Record<string, string>;
        rollbackSeconds: number;
    }): Promise<AccessStageResponse>;
    commit(transactionId: string): Promise<AccessCommitResponse>;
    rollback(transactionId: string): Promise<unknown>;
}








// -----------------------------------------------------------
// RestrictedSshAccessApplyClient
// -----------------------------------------------------------
//
// AccessApplyClient over the restricted-SSH transport. Every
// answer is matched to the request that asked for it, the
// same rule RestrictedSshAccessObservationClient applies —
// without it a stale answer left in the channel could be
// read as this transaction's result.
//
// Used by:
//   - access-clients.ts — createAccessApplier
// -----------------------------------------------------------

export class RestrictedSshAccessApplyClient implements AccessApplyClient {
    constructor(private readonly transport: Pick<RestrictedSshTransport, "execute">) {}

    async stage(input: {
        revision: string;
        files: Record<string, string>;
        rollbackSeconds: number;
    }): Promise<AccessStageResponse> {
        return this.execute(accessStageResponseSchema, (requestId) => ({
            version: 1,
            request_id: requestId,
            target: "access",
            operation: "stage",
            revision: input.revision,
            rollback_seconds: input.rollbackSeconds,
            files: input.files,
        }));
    }

    async commit(transactionId: string): Promise<AccessCommitResponse> {
        return this.execute(accessCommitResponseSchema, (requestId) => ({
            version: 1,
            request_id: requestId,
            target: "access",
            operation: "commit",
            transaction_id: transactionId,
        }));
    }

    async rollback(transactionId: string): Promise<unknown> {
        return this.transport.execute({
            version: 1,
            request_id: randomUUID(),
            target: "access",
            operation: "rollback",
            transaction_id: transactionId,
        });
    }

    private async execute<Output extends { request_id: string }>(
        schema: z.ZodType<Output>,
        request: (requestId: string) => Record<string, unknown>,
    ): Promise<Output> {
        const requestId = randomUUID();
        const result = schema.parse(await this.transport.execute(request(requestId)));
        if (result.request_id !== requestId) {
            throw new Error("Access applier request ID does not match the request");
        }
        return result;
    }
}


// The two documents an Access apply needs. They are separate because they are
// hashed separately: `infrastructure` is the database-derived plan the
// observation channel checks against, `access` is the guest policy whose
// revision the guest reports back.
export type AccessApplyPlan = {
    infrastructure: InfrastructurePlan;
    access: AccessPlan;
};








// -----------------------------------------------------------
// buildAccessApplyPlan
// -----------------------------------------------------------
//
// Derives the Access policy implied by an infrastructure
// plan and an observation.
//
// Unlike the Gateway, Access desired state is not a
// function of the database alone: the ruleset names the
// Docker bridge CIDRs the guest actually has, so the
// revision depends on an observation too. This derivation
// deliberately repeats `planAccess`'s — if the two
// disagreed, the applier would stage one revision while the
// observation channel demanded another, and no apply could
// ever converge.
//
// Used by:
//   - access-apply-runner.ts
// -----------------------------------------------------------

export function buildAccessApplyPlan(
    infrastructure: InfrastructurePlan,
    observation: AccessHostObservation,
): AccessApplyPlan {
    return {
        infrastructure,
        access: buildOperationalAccessPlan({
            groups: infrastructure.desired_state.groups.map((group) => ({
                group_id: group.group_id,
                vlan_tag: group.vlan_tag,
                subnet_cidr: group.subnet_cidr,
            })),
            trunk_vlan_ids: infrastructure.desired_state.trunks.access_vlan_ids,
            docker_bridge_cidrs: observation.guest.docker_bridge_cidrs,
        }),
    };
}








// -----------------------------------------------------------
// renderedAccessFiles
// -----------------------------------------------------------
//
// The rendered files, keyed by the absolute path they
// occupy on the guest.
//
// These paths are the contract with
// `infra/access/apply_access.py`, which refuses to write
// anything outside its allowlist. Keep them aligned with
// ALLOWED_EXACT and ALLOWED_PATTERNS there.
//
// Used by:
//   - applyAccessPolicy (below)
// -----------------------------------------------------------

export function renderedAccessFiles(plan: AccessPlan): Record<string, string> {
    const rendered = renderAccessConfiguration(plan);
    return {
        ...rendered.files.networkd,
        "/etc/sysctl.d/99-virtual-lab-access.conf": rendered.files.sysctl,
        "/etc/nftables.d/virtual-lab-access.nft": rendered.files.nftables,
    };
}


export type AccessApplyDependencies = {
    apply: AccessApplyClient;
    // Used for the pre-commit proof. This is deliberately a different client
    // from `apply`: it opens its own connection through the read-only observer
    // principal, so a commit is never authorised by the same session that made
    // the change.
    observe: AccessObservationClient;
    rollbackSeconds?: number;
};

export type AccessApplyResult = {
    transaction_id: string;
    revision: string;
    validators: string[];
    pruned: string[];
    reloaded: string[];
    nftables_include_added: boolean;
    committed: true;
};








// -----------------------------------------------------------
// applyAccessPolicy
// -----------------------------------------------------------
//
// Applies rendered Access policy and commits it only once
// an independent observation agrees that the guest
// converged.
//
// The guest arms a rollback timer before installing
// anything, so every failure path below is safe to abandon:
// not committing is itself the recovery. An explicit
// rollback is still attempted because it recovers in
// seconds rather than minutes, but it is best-effort — the
// timer remains the guarantee, and the guest cancels it
// only after the restore succeeds.
//
// Used by:
//   - access-apply-runner.ts
// -----------------------------------------------------------

export async function applyAccessPolicy(
    plan: AccessApplyPlan,
    dependencies: AccessApplyDependencies,
): Promise<AccessApplyResult> {
    const rollbackSeconds = dependencies.rollbackSeconds ?? ACCESS_ROLLBACK_SECONDS;
    const staged = await dependencies.apply.stage({
        revision: plan.access.revision,
        files: renderedAccessFiles(plan.access),
        rollbackSeconds,
    });

    // A response describing a different revision means the guest applied
    // something other than what was rendered here. Never commit that.
    if (staged.revision !== plan.access.revision) {
        throw await abandon(
            dependencies,
            staged.transaction_id,
            new AccessApplyError(
                `Access staged revision ${staged.revision}, expected ${plan.access.revision}`,
                "stage",
                staged.transaction_id,
            ),
        );
    }

    if (!staged.verification.converged) {
        const missing = plan.access.desired_state.management.service_ports
            .map(String)
            .filter((port) => !staged.verification.service_ports_listening.includes(port));
        const detail = missing.length > 0
            ? `service port(s) not listening: ${missing.join(", ")}`
            : `guest reports revision ${staged.verification.observed_revision ?? "none"}`;
        throw await abandon(
            dependencies,
            staged.transaction_id,
            new AccessApplyError(
                `Access did not converge after staging: ${detail}`,
                "stage",
                staged.transaction_id,
            ),
        );
    }

    if (!staged.rollback_armed) {
        // Without the timer there is no recovery if the next step cannot reach
        // the guest, so refuse to proceed rather than rely on this session.
        throw await abandon(
            dependencies,
            staged.transaction_id,
            new AccessApplyError(
                "Access staged without an armed rollback timer",
                "stage",
                staged.transaction_id,
            ),
        );
    }

    // The proof: a fresh connection through a different principal, checked
    // against desired state rather than trusting the applier's own report.
    // `planAccess` re-derives the policy revision from this observation, so a
    // guest whose Docker bridges moved mid-apply fails here instead of
    // committing a ruleset that no longer describes it.
    let failures: string[];
    try {
        const observation = await dependencies.observe.observe();
        failures = planAccess(plan.infrastructure, observation).checks
            // Only required checks veto: the per-port source checks report
            // "unobserved" whenever nobody happens to be connected, which is not
            // evidence of anything.
            .filter((check) => check.required && check.status !== "pass")
            .map((check) => `${check.key} (${check.detail})`);
    } catch (error) {
        throw await abandon(
            dependencies,
            staged.transaction_id,
            new AccessApplyError(
                `Access could not be observed after staging: ${
                    error instanceof Error ? error.message : "unknown failure"
                }`,
                "verify",
                staged.transaction_id,
            ),
        );
    }

    if (failures.length > 0) {
        throw await abandon(
            dependencies,
            staged.transaction_id,
            new AccessApplyError(
                `Access observation still reports drift after staging: ${failures.join("; ")}`,
                "verify",
                staged.transaction_id,
            ),
        );
    }

    const committed = await dependencies.apply.commit(staged.transaction_id);
    if (committed.rollback_armed) {
        throw new AccessApplyError(
            "Access committed but the rollback timer is still armed",
            "commit",
            staged.transaction_id,
        );
    }

    return {
        transaction_id: staged.transaction_id,
        revision: staged.revision,
        validators: staged.validators,
        pruned: staged.pruned,
        reloaded: staged.reloaded,
        nftables_include_added: staged.nftables_include_added,
        committed: true,
    };
}








// -----------------------------------------------------------
// abandon
// -----------------------------------------------------------
//
// Best-effort immediate rollback. A failure here is
// recorded on the error rather than replacing it: the
// original cause is what an operator needs, and the guest's
// timer still restores the previous state either way.
//
// Used by:
//   - applyAccessPolicy (above) — every failure path
// -----------------------------------------------------------

async function abandon(
    dependencies: AccessApplyDependencies,
    transactionId: string,
    error: AccessApplyError,
): Promise<AccessApplyError> {
    try {
        await dependencies.apply.rollback(transactionId);
        error.rolledBack = true;
    } catch {
        error.rolledBack = false;
    }
    return error;
}
