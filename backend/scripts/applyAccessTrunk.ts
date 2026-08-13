import { createAccessObserver, createAccessTrunkApplier } from "@/network/access-clients";
import { AccessTrunkApplyError } from "@/network/access-trunk-apply";
import { AccessTrunkApplyRunner } from "@/network/access-trunk-runner";
import { pool } from "@/utils/db";
import { z } from "zod";

/**
 * Operator entry point for reconciling the Access LXC's VLAN trunk.
 *
 * Unlike the policy applier, this mutates the hypervisor rather than the
 * container: `pct set 200 --net1 ...,trunks=<list>` for the persistent
 * allowlist and `bridge vlan add/del` for the running veth. Both halves are
 * needed, because neither implies the other.
 *
 * Provisioning drives the same runner automatically; this exists so trunk drift
 * can be repaired without creating a VM to trigger it.
 */
const argumentsSchema = z.object({
    requestedBy: z.string().min(1),
    expectedRevision: z.string().regex(/^[0-9a-f]{64}$/),
    rollbackSeconds: z.coerce.number().int().min(60).max(1800).optional(),
    idempotencyKey: z.string().min(1).max(255).optional(),
    confirmation: z.literal("APPLY-ACCESS-TRUNK"),
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
            "Usage: npm run apply-access-trunk -- --requested-by <vu_id> "
            + "--expected-revision <infrastructure sha256> [--rollback-seconds <60-1800>] "
            + "[--idempotency-key <key>] "
            + "--confirm APPLY-ACCESS-TRUNK",
        );
    }

    const observe = createAccessObserver();
    const apply = createAccessTrunkApplier();

    try {
        const attempt = await new AccessTrunkApplyRunner({
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
            // Empty when the trunk already held desired state. That is a
            // succeeded attempt, not a skipped one.
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
    if (error instanceof AccessTrunkApplyError) {
        process.stderr.write(`${JSON.stringify({
            error: error.message,
            stage: error.stage,
            transaction_id: error.transactionId,
            rolled_back_immediately: error.rolledBack,
            note: error.rolledBack
                ? "the host was restored immediately"
                : "the host's rollback timer will restore the previous trunk",
        })}\n`);
    } else {
        console.error(error instanceof Error ? error.message : "Access trunk apply failed");
    }
    process.exitCode = 1;
});
