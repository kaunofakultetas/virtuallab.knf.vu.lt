import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
    GatewayObservationClient,
    planGateway,
    renderedGatewayFiles,
} from "./adapters/gateway";
import { RestrictedSshTransport } from "./adapters/restricted-ssh";
import { GatewayPlan } from "./gateway-desired-state";

/**
 * Default window between staging and committing. Long enough for an independent
 * observation over a fresh connection, short enough that a lockout is measured
 * in minutes. The guest clamps this to its own bounds.
 */
export const GATEWAY_ROLLBACK_SECONDS = 300;

export class GatewayApplyError extends Error {
    /** Whether the immediate rollback succeeded; undefined if none was attempted. */
    rolledBack?: boolean;

    constructor(
        message: string,
        readonly stage: "stage" | "verify" | "commit",
        readonly transactionId?: string,
    ) {
        super(message);
        this.name = "GatewayApplyError";
    }
}

const verificationSchema = z.object({
    services_inactive: z.array(z.string()),
    observed_revision: z.string().nullable(),
    revision_matches: z.boolean(),
    converged: z.boolean(),
});

export const gatewayStageResponseSchema = z.object({
    version: z.literal(1),
    request_id: z.string(),
    target: z.literal("gateway"),
    operation: z.literal("stage"),
    transaction_id: z.string().min(1),
    revision: z.string().regex(/^[0-9a-f]{64}$/),
    validators: z.array(z.string()),
    // Managed paths removed because desired state no longer wants them. A
    // released group's VLAN files are invisible to the renderer, so pruning is
    // the only way an apply converges.
    pruned: z.array(z.string()),
    reloaded: z.array(z.string()),
    verification: verificationSchema,
    rollback_armed: z.boolean(),
    rollback_seconds: z.number().int(),
});

export const gatewayCommitResponseSchema = z.object({
    version: z.literal(1),
    request_id: z.string(),
    target: z.literal("gateway"),
    operation: z.literal("commit"),
    transaction_id: z.string().min(1),
    revision: z.string(),
    committed: z.literal(true),
    rollback_armed: z.boolean(),
    verification: verificationSchema,
});

export type GatewayStageResponse = z.infer<typeof gatewayStageResponseSchema>;
export type GatewayCommitResponse = z.infer<typeof gatewayCommitResponseSchema>;

export interface GatewayApplyClient {
    stage(input: {
        revision: string;
        files: Record<string, string>;
        rollbackSeconds: number;
    }): Promise<GatewayStageResponse>;
    commit(transactionId: string): Promise<GatewayCommitResponse>;
    rollback(transactionId: string): Promise<unknown>;
}

export class RestrictedSshGatewayApplyClient implements GatewayApplyClient {
    constructor(private readonly transport: Pick<RestrictedSshTransport, "execute">) {}

    async stage(input: {
        revision: string;
        files: Record<string, string>;
        rollbackSeconds: number;
    }): Promise<GatewayStageResponse> {
        return gatewayStageResponseSchema.parse(await this.transport.execute({
            version: 1,
            request_id: randomUUID(),
            target: "gateway",
            operation: "stage",
            revision: input.revision,
            rollback_seconds: input.rollbackSeconds,
            files: input.files,
        }));
    }

    async commit(transactionId: string): Promise<GatewayCommitResponse> {
        return gatewayCommitResponseSchema.parse(await this.transport.execute({
            version: 1,
            request_id: randomUUID(),
            target: "gateway",
            operation: "commit",
            transaction_id: transactionId,
        }));
    }

    async rollback(transactionId: string): Promise<unknown> {
        return this.transport.execute({
            version: 1,
            request_id: randomUUID(),
            target: "gateway",
            operation: "rollback",
            transaction_id: transactionId,
        });
    }
}

export type GatewayApplyDependencies = {
    apply: GatewayApplyClient;
    /**
     * Used for the pre-commit proof. This is deliberately a different client
     * from `apply`: it opens its own SSH connection through the read-only
     * observer principal, so a commit is never authorised by the same session
     * that made the change.
     */
    observe: GatewayObservationClient;
    rollbackSeconds?: number;
};

export type GatewayApplyResult = {
    transaction_id: string;
    revision: string;
    validators: string[];
    pruned: string[];
    reloaded: string[];
    committed: true;
};

/**
 * Applies rendered Gateway policy and commits it only once an independent
 * observation agrees that the guest converged.
 *
 * The guest arms a rollback timer before installing anything, so every failure
 * path below is safe to abandon: not committing is itself the recovery. An
 * explicit rollback is still attempted because it recovers in seconds rather
 * than minutes, but it is best-effort — the timer remains the guarantee, and the
 * guest cancels it only after the restore succeeds.
 */
export async function applyGatewayPolicy(
    plan: GatewayPlan,
    dependencies: GatewayApplyDependencies,
): Promise<GatewayApplyResult> {
    const rollbackSeconds = dependencies.rollbackSeconds ?? GATEWAY_ROLLBACK_SECONDS;
    const staged = await dependencies.apply.stage({
        revision: plan.revision,
        files: renderedGatewayFiles(plan),
        rollbackSeconds,
    });

    // A response describing a different revision means the guest applied
    // something other than what was rendered here. Never commit that.
    if (staged.revision !== plan.revision) {
        throw await abandon(
            dependencies,
            staged.transaction_id,
            new GatewayApplyError(
                `Gateway staged revision ${staged.revision}, expected ${plan.revision}`,
                "stage",
                staged.transaction_id,
            ),
        );
    }

    if (!staged.verification.converged) {
        const detail = staged.verification.services_inactive.length > 0
            ? `inactive service(s): ${staged.verification.services_inactive.join(", ")}`
            : `guest reports revision ${staged.verification.observed_revision ?? "none"}`;
        throw await abandon(
            dependencies,
            staged.transaction_id,
            new GatewayApplyError(
                `Gateway did not converge after staging: ${detail}`,
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
            new GatewayApplyError(
                "Gateway staged without an armed rollback timer",
                "stage",
                staged.transaction_id,
            ),
        );
    }

    // The proof: a fresh connection through a different principal, checked
    // against desired state rather than trusting the applier's own report.
    let failures: string[];
    try {
        const observation = await dependencies.observe.observe();
        failures = planGateway(plan, observation).checks
            .filter((check) => check.status !== "pass")
            .map((check) => `${check.key} (${check.detail})`);
    } catch (error) {
        throw await abandon(
            dependencies,
            staged.transaction_id,
            new GatewayApplyError(
                `Gateway could not be observed after staging: ${
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
            new GatewayApplyError(
                `Gateway observation still reports drift after staging: ${failures.join("; ")}`,
                "verify",
                staged.transaction_id,
            ),
        );
    }

    const committed = await dependencies.apply.commit(staged.transaction_id);
    if (committed.rollback_armed) {
        throw new GatewayApplyError(
            "Gateway committed but the rollback timer is still armed",
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
        committed: true,
    };
}

/**
 * Best-effort immediate rollback. A failure here is recorded on the error rather
 * than replacing it: the original cause is what an operator needs, and the
 * guest's timer still restores the previous state either way.
 */
async function abandon(
    dependencies: GatewayApplyDependencies,
    transactionId: string,
    error: GatewayApplyError,
): Promise<GatewayApplyError> {
    try {
        await dependencies.apply.rollback(transactionId);
        error.rolledBack = true;
    } catch {
        error.rolledBack = false;
    }
    return error;
}
