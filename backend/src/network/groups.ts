// -----------------------------------------------------------
//  [*] Network — the group state machine and allocator
//
//  Every transition a network group makes lives here, each
//  one guarded in SQL so a concurrent writer can never
//  observe a half-move: planned → creating (allocation,
//  under an advisory lock), creating → active (promotion),
//  anything-with-no-VMs → deleting (teardown entry),
//  deleting → gone (release), plus the error annotations.
//  The guards ARE the design — most functions here exist to
//  make one specific race impossible.
//
//  Used by:
//    - attachment.ts, instances.route.ts / controller —
//      allocation, promotion, planned-group cleanup
//    - teardown.ts — deleting/release transitions
//    - network.route.ts — the group listing
// -----------------------------------------------------------

import { QueryResult, QueryResultRow } from "pg";
import { NetworkGroup } from "@/types/network-groups";
import { pool } from "@/utils/db";
import { getNetworkSlot, networkProjectionConfig } from "./config";
import { getNetworkPlan, ProjectedNetworkGroup } from "./desired-state";

const NETWORK_ALLOCATION_ADVISORY_LOCK = 1447838018; // ASCII "VLAB" as a 32-bit key.

export class NetworkAllocationError extends Error {}








// -----------------------------------------------------------
// findLowestAvailableVlan
// -----------------------------------------------------------
//
// The pool scan; throws when 2000-2255 is exhausted.
//
// Used by:
//   - allocateNetworkGroup (below)
//   - test/network-allocator.test.ts
// -----------------------------------------------------------

export function findLowestAvailableVlan(
    occupiedVlans: Iterable<number>,
    first: number = networkProjectionConfig.vlan.first,
    last: number = networkProjectionConfig.vlan.last,
): number {
    const occupied = new Set(occupiedVlans);
    for (let vlanTag = first; vlanTag <= last; vlanTag += 1) {
        if (!occupied.has(vlanTag)) {
            return vlanTag;
        }
    }
    throw new NetworkAllocationError(`Network allocation pool ${first}-${last} is exhausted`);
}


// All-or-nothing, and canonical: a partial or non-slot-matching allocation
// means the row and the projection disagree, and neither can be trusted.
function validatePersistedAllocation(group: NetworkGroup): boolean {
    const fields = [group.vlan_tag, group.vnet_name, group.subnet_cidr];
    const populatedCount = fields.filter((field) => field !== null).length;
    if (populatedCount === 0) {
        return false;
    }
    if (populatedCount !== fields.length) {
        throw new NetworkAllocationError(`Network group ${group.id} has a partial allocation`);
    }

    const slot = getNetworkSlot(group.vlan_tag!);
    if (group.vnet_name !== slot.vnetName || group.subnet_cidr !== slot.subnetCidr) {
        throw new NetworkAllocationError(`Network group ${group.id} has a non-canonical allocation`);
    }
    return true;
}


// Minimal surface `allocateNetworkGroup` needs, so the transaction can be
// exercised without a live PostgreSQL. The advisory lock and `FOR UPDATE` are
// the whole point of this function, and neither is testable through the
// exported helpers alone.
export type NetworkAllocationPool = {
    connect(): Promise<{
        query<Row extends QueryResultRow = QueryResultRow>(
            queryText: string,
            values?: unknown[],
        ): Promise<QueryResult<Row>>;
        release(): void;
    }>;
};








// -----------------------------------------------------------
// allocateNetworkGroup
// -----------------------------------------------------------
//
// planned/error → creating with a claimed slot, in one
// transaction under the allocation advisory lock + FOR
// UPDATE. An already-allocated group short-circuits (with
// the error-state resume documented inline); an unallocated
// one claims the lowest free VLAN and records the new plan
// revision as its desired_revision.
//
// Used by:
//   - attachment.ts — resolveNetworkAttachment in active mode
// -----------------------------------------------------------

export async function allocateNetworkGroup(
    groupId: number,
    database: NetworkAllocationPool = pool,
): Promise<NetworkGroup> {
    const client = await database.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1)", [
            NETWORK_ALLOCATION_ADVISORY_LOCK,
        ]);
        const current = await client.query<NetworkGroup>(
            `SELECT * FROM network_groups WHERE id = $1 FOR UPDATE`,
            [groupId],
        );
        const group = current.rows[0];
        if (!group) {
            throw new NetworkAllocationError(`Network group ${groupId} does not exist`);
        }
        if (validatePersistedAllocation(group)) {
            if (group.state === "planned") {
                throw new NetworkAllocationError(
                    `Network group ${group.id} is planned but already has an allocation`,
                );
            }
            if (group.state === "error") {
                // A failed provisioning attempt keeps its allocation on purpose,
                // but leaving the group `error` would make it permanently
                // unusable: the caller refuses any state other than creating or
                // active, and nothing else moves it back. Every reconciler is
                // convergent and idempotent over the whole desired state, so the
                // right response to a retry is to resume, not to strand the
                // student's only group behind an admin's manual repair.
                //
                // The allocation itself is untouched, and the desired-state
                // revision does not move: `state` only selects which rows are
                // operational, and an errored row with a VLAN was already one.
                const resumed = await client.query<NetworkGroup>(
                    `UPDATE network_groups
                     SET state = 'creating',
                         last_error = NULL,
                         updated_at = NOW()
                     WHERE id = $1
                     RETURNING *`,
                    [groupId],
                );
                await client.query("COMMIT");
                return resumed.rows[0];
            }
            await client.query("COMMIT");
            return group;
        }
        if (group.state !== "planned" && group.state !== "error") {
            throw new NetworkAllocationError(
                `Network group ${group.id} is ${group.state} but has no allocation`,
            );
        }

        const occupiedResult = await client.query<{ vlan_tag: number }>(
            `SELECT vlan_tag
             FROM network_groups
             WHERE vlan_tag IS NOT NULL
             ORDER BY vlan_tag`,
        );
        const vlanTag = findLowestAvailableVlan(
            occupiedResult.rows.map((row) => row.vlan_tag),
        );
        const slot = getNetworkSlot(vlanTag);
        await client.query(
            `UPDATE network_groups
             SET vlan_tag = $2,
                 vnet_name = $3,
                 subnet_cidr = $4,
                 state = 'creating',
                 desired_revision = NULL,
                 applied_revision = NULL,
                 last_error = NULL,
                 updated_at = NOW()
             WHERE id = $1`,
            [groupId, slot.vlanTag, slot.vnetName, slot.subnetCidr],
        );

        const plan = await getNetworkPlan(client);
        const allocated = await client.query<NetworkGroup>(
            `UPDATE network_groups
             SET desired_revision = $2,
                 updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [groupId, plan.revision],
        );
        await client.query("COMMIT");
        return allocated.rows[0];
    } catch (error) {
        await client.query("ROLLBACK");
        // 23505 = unique violation — another writer claimed the same slot.
        if ((error as { code?: string }).code === "23505") {
            throw new NetworkAllocationError("Network allocation conflicted with another writer");
        }
        throw error;
    } finally {
        client.release();
    }
}


export type NetworkGroupSummary = NetworkGroup & {
    profile_name: string;
    instance_count: number;
    projection: ProjectedNetworkGroup;
};








// -----------------------------------------------------------
// getOrCreatePlannedGroup
// -----------------------------------------------------------
//
// One group per (owner, profile): the no-op DO UPDATE makes
// the upsert return the existing row instead of failing.
//
// Used by:
//   - instances.route.ts — POST /instances
// -----------------------------------------------------------

export async function getOrCreatePlannedGroup(
    ownerId: string,
    profileId: number,
): Promise<NetworkGroup> {
    const result = await pool.query<NetworkGroup>(
        `INSERT INTO network_groups (owner_id, profile_id, state)
         VALUES ($1, $2, 'planned')
         ON CONFLICT (owner_id, profile_id) DO UPDATE
         SET owner_id = EXCLUDED.owner_id
         RETURNING *`,
        [ownerId, profileId],
    );
    return result.rows[0];
}








// -----------------------------------------------------------
// markNetworkGroupError
// -----------------------------------------------------------
//
// Records a failed provisioning attempt against an
// already-allocated group.
//
// The allocation is deliberately retained. Its VLAN and
// subnet must not return to the pool until a teardown has
// verified that no Proxmox resource still references them,
// because infrastructure may already have been created.
//
// Used by:
//   - attachment.ts — compensateNetworkAttachment
// -----------------------------------------------------------

export async function markNetworkGroupError(
    groupId: number,
    lastError: string,
): Promise<void> {
    await pool.query(
        `UPDATE network_groups
         SET state = 'error',
             last_error = $2,
             updated_at = NOW()
         WHERE id = $1
           -- Guarded like every other transition here. Without a predicate a
           -- failed provisioning attempt demoted whatever it found: an 'active'
           -- group whose other VMs are running and converged, or a 'deleting'
           -- group mid-teardown, which would drag it back into the operational
           -- plan while its VNet was already gone.
           AND state IN ('planned', 'creating', 'error')
           AND NOT EXISTS (
               SELECT 1 FROM instances WHERE network_group_id = $1
           )`,
        [groupId, lastError],
    );
}








// -----------------------------------------------------------
// markNetworkGroupActive
// -----------------------------------------------------------
//
// Promotes a group whose infrastructure is fully
// reconciled.
//
// Guarded on `creating`, so a concurrent teardown that
// already moved the group to `deleting` is never dragged
// back into service by a provisioning request that started
// earlier.
//
// `applied_revision` records the infrastructure revision
// every executor converged on, which is what makes "active"
// mean something an operator can check rather than a state
// somebody set.
//
// Used by:
//   - instances.route.ts — after the VM firewall applied
// -----------------------------------------------------------

export async function markNetworkGroupActive(
    groupId: number,
    appliedRevision: string,
): Promise<NetworkGroup | null> {
    const result = await pool.query<NetworkGroup>(
        `UPDATE network_groups
         SET state = 'active',
             applied_revision = $2,
             last_error = NULL,
             updated_at = NOW()
         -- 'deleting' is accepted as a recovery path, not as a normal
         -- transition. A teardown that began while this VM was mid-clone could
         -- mark the group deleting (its guard saw no instances yet, because the
         -- row had not been written), and the group would then be stranded:
         -- excluded from firewall reconciliation, but carrying a live VM.
         -- Reservation rows make that race far harder to hit; this makes it
         -- recoverable when it still does.
         WHERE id = $1 AND state IN ('creating', 'deleting')
         RETURNING *`,
        [groupId, appliedRevision],
    );
    return result.rows[0] ?? null;
}








// -----------------------------------------------------------
// markNetworkGroupDeleting
// -----------------------------------------------------------
//
// Moves a group out of the operational plan so teardown can
// proceed.
//
// The instance check is inside the same statement rather
// than a separate read: a VM created between a check and an
// update would otherwise have its network dismantled
// underneath it. `deleting` is not an operational state, so
// the moment this commits every reconciler stops projecting
// the group's VLAN — which is exactly what makes the later
// prune steps converge.
//
// Returns null when the group still has instances or is not
// in a state that may be torn down, so a caller can tell
// "refused" from "done".
//
// Used by:
//   - teardown.ts — the first teardown step
// -----------------------------------------------------------

export async function markNetworkGroupDeleting(groupId: number): Promise<NetworkGroup | null> {
    const result = await pool.query<NetworkGroup>(
        `UPDATE network_groups network_group
         SET state = 'deleting',
             updated_at = NOW()
         WHERE network_group.id = $1
           -- 'deleting' is included so a teardown that failed part-way can be
           -- retried. Without it a group whose Gateway reconciliation failed
           -- would be permanently stuck: its VLAN reserved, its row unreleasable,
           -- and no path back. Teardown is idempotent by construction, so
           -- re-entering it is the correct response to a partial one.
           AND network_group.state IN ('creating', 'active', 'error', 'deleting')
           AND NOT EXISTS (
               SELECT 1 FROM instances WHERE network_group_id = network_group.id
           )
         RETURNING *`,
        [groupId],
    );
    return result.rows[0] ?? null;
}








// -----------------------------------------------------------
// markNetworkGroupTeardownError
// -----------------------------------------------------------
//
// Records why a teardown stopped, on the row it stopped on.
//
// Guarded on `deleting` so it can only ever annotate a
// group that teardown actually owns; `markNetworkGroupError`
// refuses that state on purpose, because demoting a
// mid-teardown group to `error` would drag it back into the
// operational plan while its VNet was already gone.
//
// The state is deliberately left alone. This writes a
// reason, not a transition: the group stays `deleting` and
// stays retryable, and the allocation stays reserved.
// Without it a stranded group carried no diagnosis at all —
// the only record of why it stopped was a log line, and the
// operator looking at the row saw `deleting` with a NULL
// `last_error` and nothing to act on.
//
// Used by:
//   - teardown.ts — on a failed teardown step
// -----------------------------------------------------------

export async function markNetworkGroupTeardownError(
    groupId: number,
    lastError: string,
): Promise<void> {
    await pool.query(
        `UPDATE network_groups
         SET last_error = $2,
             updated_at = NOW()
         WHERE id = $1
           AND state = 'deleting'`,
        [groupId, lastError],
    );
}








// -----------------------------------------------------------
// deleteNetworkGroupRecord
// -----------------------------------------------------------
//
// Releases a torn-down group's VLAN and subnet by removing
// the row.
//
// Both guards matter and neither is redundant: `deleting`
// proves the caller went through teardown rather than
// deleting a live group, and the instance check catches a
// VM attached during it. Releasing either way would hand a
// subnet to another owner while Proxmox resources still
// referenced it.
//
// Used by:
//   - teardown.ts — the final teardown step
// -----------------------------------------------------------

export async function deleteNetworkGroupRecord(groupId: number): Promise<boolean> {
    const result = await pool.query(
        `DELETE FROM network_groups network_group
         WHERE network_group.id = $1
           AND network_group.state = 'deleting'
           AND NOT EXISTS (
               SELECT 1 FROM instances WHERE network_group_id = network_group.id
           )`,
        [groupId],
    );
    return (result.rowCount ?? 0) > 0;
}








// -----------------------------------------------------------
// deleteUnusedPlannedGroup
// -----------------------------------------------------------
//
// Removes a still-`planned`, instance-free group — cleanup
// after a failed or abandoned non-isolated provisioning.
//
// Used by:
//   - instances.controller.ts — after instance deletion
//   - attachment.ts — compensation for a planned group
// -----------------------------------------------------------

export async function deleteUnusedPlannedGroup(groupId: number): Promise<void> {
    await pool.query(
        `DELETE FROM network_groups network_group
         WHERE network_group.id = $1
           AND network_group.state = 'planned'
           AND NOT EXISTS (
               SELECT 1 FROM instances WHERE network_group_id = network_group.id
           )`,
        [groupId],
    );
}








// -----------------------------------------------------------
// getNetworkGroups
// -----------------------------------------------------------
//
// The admin listing: every group with its profile name,
// instance count, and its projection from the current plan
// (an unprojectable group is an invariant violation worth
// throwing on).
//
// Used by:
//   - network.route.ts — GET /network/groups
// -----------------------------------------------------------

export async function getNetworkGroups(): Promise<NetworkGroupSummary[]> {
    const [result, plan] = await Promise.all([
        pool.query<NetworkGroup & { profile_name: string; instance_count: string }>(`
            SELECT
                network_group.*,
                profile.name AS profile_name,
                count(instance.id) AS instance_count
            FROM network_groups network_group
            JOIN lab_profiles profile ON profile.id = network_group.profile_id
            LEFT JOIN instances instance ON instance.network_group_id = network_group.id
            GROUP BY network_group.id, profile.name
            ORDER BY network_group.id
        `),
        getNetworkPlan(),
    ]);
    const projections = new Map(
        plan.desired_state.groups.map((projection) => [projection.group_id, projection]),
    );

    return result.rows.map((row) => {
        const projection = projections.get(row.id);
        if (!projection) {
            throw new Error(`Network group ${row.id} is missing from the desired-state plan`);
        }
        return {
            ...row,
            instance_count: Number(row.instance_count),
            projection,
        };
    });
}
