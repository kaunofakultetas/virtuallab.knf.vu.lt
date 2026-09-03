// -----------------------------------------------------------
//  [*] Network — releasing a group after its last VM
//
//  The bridge between instance deletion and network
//  teardown: whichever path removed a group's last VM calls
//  this to return the VLAN to the pool.
//
//  Used by:
//    - instances.route.ts — the user-facing delete
//    - instances.controller.ts — the expiry sweeper
// -----------------------------------------------------------

import { NetworkGroup } from "@/types/network-groups";
import { pool } from "@/utils/db";
import { logger } from "@/utils/logger";
import { NetworkTeardownOutcome, releaseNetworkGroup } from "./teardown";

export type ReleaseAfterInstanceDependencies = {
    getGroup?: (groupId: number) => Promise<NetworkGroup | null>;
    release?: typeof releaseNetworkGroup;
};








// -----------------------------------------------------------
// releaseNetworkGroupAfterInstance
// -----------------------------------------------------------
//
// Releases a group once its last VM is gone.
//
// It never throws. The VM is already gone by the time this
// runs, so a failed teardown is a leaked VLAN and a group
// stuck in `deleting` — worth an error in the log and a
// retry later, but not worth telling the caller their
// deletion failed when it did not. The allocation stays
// reserved either way, which is the safe direction: a VLAN
// nobody can reuse beats one handed to a second owner while
// Proxmox still carries the first one's bridge.
//
// The group is looked up before deletion elsewhere, because
// the instance row carrying `network_group_id` is exactly
// what gets removed.
//
// Used by:
//   - instances.route.ts, instances.controller.ts (above)
// -----------------------------------------------------------

export async function releaseNetworkGroupAfterInstance(
    networkGroupId: number | null | undefined,
    requestedBy: string,
    dependencies: ReleaseAfterInstanceDependencies = {},
): Promise<NetworkTeardownOutcome | null> {
    if (networkGroupId === null || networkGroupId === undefined) return null;
    const getGroup = dependencies.getGroup ?? (async (id: number) => (
        (await pool.query<NetworkGroup>(
            "SELECT * FROM network_groups WHERE id = $1",
            [id],
        )).rows[0] ?? null
    ));

    try {
        const group = await getGroup(networkGroupId);
        if (!group) return null;
        const outcome = await (dependencies.release ?? releaseNetworkGroup)(group, requestedBy);
        if (outcome.released) {
            logger.info(
                {
                    networkGroupId,
                    vlanTag: outcome.vlan_tag,
                    vnetName: outcome.vnet_name,
                    steps: outcome.steps,
                },
                "Released a network group and returned its VLAN to the pool",
            );
        } else {
            logger.debug(
                { networkGroupId, reason: outcome.reason },
                "Network group was not released",
            );
        }
        return outcome;
    } catch (error) {
        logger.error(
            { err: error, networkGroupId },
            "Failed to release a network group; its VLAN stays reserved until a retry",
        );
        return null;
    }
}
