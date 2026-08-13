import { AccessApplyError } from "@/network/access-apply";
import { AccessApplyRunner } from "@/network/access-apply-runner";
import { createAccessApplier, createAccessObserver } from "@/network/access-clients";
import { pool } from "@/utils/db";
import { z } from "zod";

/**
 * Operator entry point for applying rendered Access guest policy to LXC 200.
 *
 * Deliberately a CLI and not an HTTP route, matching apply-network-vnets and
 * apply-gateway-policy: the plan keeps active infrastructure mutation off the
 * API surface until the behaviour is proven operationally. Provisioning drives
 * the same runner automatically; this exists so drift can be repaired without
 * creating a VM to trigger it.
 *
 * `--expected-revision` is the INFRASTRUCTURE revision, not the Access policy
 * revision. The policy revision is a function of the guest's observed Docker
 * bridges, so a caller cannot hold it as a precondition; the infrastructure
 * revision is the one a dry-run publishes.
 */
const argumentsSchema = z.object({
    requestedBy: z.string().min(1),
    expectedRevision: z.string().regex(/^[0-9a-f]{64}$/),
    rollbackSeconds: z.coerce.number().int().min(60).max(1800).optional(),
    idempotencyKey: z.string().min(1).max(255).optional(),
    confirmation: z.literal("APPLY-ACCESS-POLICY"),
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
            "Usage: npm run apply-access-policy -- --requested-by <vu_id> "
            + "--expected-revision <infrastructure sha256> [--rollback-seconds <60-1800>] "
            + "[--idempotency-key <key>] "
            + "--confirm APPLY-ACCESS-POLICY",
        );
    }

    // Both channels are required, and they are deliberately different
    // principals: committing on the applier's own report alone would remove the
    // only cross-check this design has.
    const observe = createAccessObserver();
    const apply = createAccessApplier();

    try {
        const attempt = await new AccessApplyRunner({
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
            actions: attempt.actions,
            error_code: attempt.error_code,
            error_detail: attempt.error_detail,
        })}\n`);
        if (attempt.status !== "succeeded") process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

main().catch((error: unknown) => {
    if (error instanceof AccessApplyError) {
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
        console.error(error instanceof Error ? error.message : "Access apply failed");
    }
    process.exitCode = 1;
});
