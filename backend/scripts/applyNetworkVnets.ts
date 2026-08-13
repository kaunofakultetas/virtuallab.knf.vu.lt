import { InfrastructureApplyRunner } from "@/network/infrastructure-apply-runner";
import { createNetworkProxmoxMutator } from "@/network/proxmox-clients";
import { pool } from "@/utils/db";
import { z } from "zod";

const argumentsSchema = z.object({
    requestedBy: z.string().min(1),
    expectedRevision: z.string().regex(/^[0-9a-f]{64}$/),
    idempotencyKey: z.string().min(1).max(255).optional(),
    confirmation: z.literal("APPLY-PROXMOX-VNETS"),
});

function option(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
    const parsed = argumentsSchema.safeParse({
        requestedBy: option("--requested-by"),
        expectedRevision: option("--expected-revision"),
        idempotencyKey: option("--idempotency-key"),
        confirmation: option("--confirm"),
    });
    if (!parsed.success) {
        throw new Error(
            "Usage: npm run apply-network-vnets -- --requested-by <vu_id> "
            + "--expected-revision <sha256> [--idempotency-key <key>] "
            + "--confirm APPLY-PROXMOX-VNETS",
        );
    }

    const proxmox = createNetworkProxmoxMutator();
    try {
        const attempt = await new InfrastructureApplyRunner({
            database: pool,
            proxmox,
        }).applyVnets({
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
            actions: attempt.actions.length,
        })}\n`);
        if (attempt.status !== "succeeded") process.exitCode = 1;
    } finally {
        await proxmox.close();
        await pool.end();
    }
}

main().catch(async (error) => {
    console.error(error instanceof Error ? error.message : "VNet apply failed");
    await pool.end().catch(() => undefined);
    process.exitCode = 1;
});