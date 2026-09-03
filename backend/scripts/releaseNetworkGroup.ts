// -----------------------------------------------------------
//  [*] Scripts — release-network-group (operator CLI)
//
//  Operator entry point for releasing a network group's
//  VLAN and subnet. Provisioning drives teardown
//  automatically when the last VM is deleted; this exists
//  for the case that path leaves behind: a teardown that
//  failed part-way puts the group in `deleting` with its
//  allocation still reserved, deliberately, and something
//  has to be able to resume it. Teardown is idempotent, so
//  a retry simply continues from wherever the previous
//  attempt stopped.
//
//  It refuses a group that still has instances, and one
//  whose VNet is still referenced by a guest, so it cannot
//  be used to strip a live lab. The admin Network page
//  drives the same teardown over HTTP; this survives when
//  the API is down.
//
//  Usage:
//    npm run release-network-group -- --group-id <id>
//      --requested-by <vu_id> --confirm RELEASE-NETWORK-GROUP
// -----------------------------------------------------------

import { pool } from "@/utils/db";
import { NetworkGroup } from "@/types/network-groups";
import { NetworkTeardownError, releaseNetworkGroup } from "@/network/teardown";
import { z } from "zod";

const argumentsSchema = z.object({
    groupId: z.coerce.number().int().positive(),
    requestedBy: z.string().min(1),
    confirmation: z.literal("RELEASE-NETWORK-GROUP"),
});


function option(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}


async function main(): Promise<void> {
    const parsed = argumentsSchema.safeParse({
        groupId: option("--group-id"),
        requestedBy: option("--requested-by"),
        confirmation: option("--confirm"),
    });
    if (!parsed.success) {
        throw new Error(
            "Usage: npm run release-network-group -- --group-id <id> "
            + "--requested-by <vu_id> --confirm RELEASE-NETWORK-GROUP",
        );
    }

    try {
        const group = (await pool.query<NetworkGroup>(
            "SELECT * FROM network_groups WHERE id = $1",
            [parsed.data.groupId],
        )).rows[0];
        if (!group) throw new Error(`Network group ${parsed.data.groupId} does not exist`);

        const outcome = await releaseNetworkGroup(group, parsed.data.requestedBy);
        process.stdout.write(`${JSON.stringify(outcome)}\n`);
        if (!outcome.released) process.exitCode = 1;
    } finally {
        await pool.end();
    }
}


main().catch((error: unknown) => {
    if (error instanceof NetworkTeardownError) {
        // The group stays in `deleting` with its allocation reserved, which is
        // the safe direction: a VLAN nobody can reuse beats one handed to a
        // second owner while Proxmox still carries the first one's resources.
        process.stderr.write(`${JSON.stringify({
            error: error.message,
            step: error.step,
            note: "the group remains in `deleting`; rerun this command once the cause is fixed",
        })}\n`);
    } else {
        console.error(error instanceof Error ? error.message : "Network group release failed");
    }
    process.exitCode = 1;
});
