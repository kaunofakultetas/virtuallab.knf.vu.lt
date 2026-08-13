import { GatewayApplyError } from "@/network/gateway-apply";
import { GatewayApplyRunner } from "@/network/gateway-apply-runner";
import { createGatewayApplier, createGatewayObserver } from "@/network/gateway-clients";
import { pool } from "@/utils/db";
import { z } from "zod";

/**
 * Operator entry point for applying rendered Gateway policy.
 *
 * Deliberately a CLI and not an HTTP route, matching apply-network-vnets: the
 * plan keeps active infrastructure mutation off the API surface until the
 * behaviour is proven operationally.
 *
 * `--expected-revision` is required, not optional. The operator is expected to
 * have read a dry-run first, and the guard makes it impossible to apply a plan
 * that changed between reading it and confirming it.
 */
const argumentsSchema = z.object({
    requestedBy: z.string().min(1),
    expectedRevision: z.string().regex(/^[0-9a-f]{64}$/),
    rollbackSeconds: z.coerce.number().int().min(60).max(1800).optional(),
    idempotencyKey: z.string().min(1).max(255).optional(),
    confirmation: z.literal("APPLY-GATEWAY-POLICY"),
});

function option(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
    const parsed = argumentsSchema.safeParse({
        requestedBy: option("--requested-by"),
        expectedRevision: option("--expected-revision"),
        rollbackSeconds: option("--rollback-seconds"),
        idempotencyKey: option("--idempotency-key"),
        confirmation: option("--confirm"),
    });
    if (!parsed.success) {
        throw new Error(
            "Usage: npm run apply-gateway-policy -- --requested-by <vu_id> "
            + "--expected-revision <sha256> [--rollback-seconds <60-1800>] "
            + "[--idempotency-key <key>] "
            + "--confirm APPLY-GATEWAY-POLICY",
        );
    }

    // Refuse before touching the guest if convergence cannot be proven
    // independently. Committing on the applier's own report alone would remove
    // the only cross-check this design has.
    const observe = createGatewayObserver();
    if (!observe) {
        throw new Error(
            "Gateway observation is not configured; an apply cannot be verified independently",
        );
    }
    const apply = createGatewayApplier();

    try {
        // The runner takes the shared reconciliation lock and records the
        // attempt, so a Gateway apply leaves the same audit trail as a VNet one.
        const attempt = await new GatewayApplyRunner({
            database: pool,
            apply,
            observe,
            rollbackSeconds: parsed.data.rollbackSeconds,
        }).apply({
            requestedBy: parsed.data.requestedBy,
            expectedRevision: parsed.data.expectedRevision,
            idempotencyKey: parsed.data.idempotencyKey,
        });
        process.stdout.write(`${JSON.stringify({
            attempt_id: attempt.id,
            status: attempt.status,
            phase: attempt.phase,
            desired_revision: attempt.desired_revision,
            applied_revision: attempt.applied_revision,
            error_code: attempt.error_code,
            error_detail: attempt.error_detail,
        })}\n`);
        if (attempt.status !== "succeeded") process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

main().catch((error: unknown) => {
    if (error instanceof GatewayApplyError) {
        // A failed apply is not silent breakage: the guest armed a rollback
        // timer before installing anything, so report what recovery happened.
        process.stderr.write(`${JSON.stringify({
            error: error.message,
            stage: error.stage,
            transaction_id: error.transactionId,
            rolled_back_immediately: error.rolledBack,
            note: error.rolledBack
                ? "the guest was restored immediately"
                : "the guest's rollback timer will restore the previous state",
        })}\n`);
    } else {
        console.error(error instanceof Error ? error.message : "Gateway apply failed");
    }
    process.exitCode = 1;
});
