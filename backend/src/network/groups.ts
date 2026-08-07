import { NetworkGroup } from "@/types/network-groups";
import { pool } from "@/utils/db";
import { getNetworkSlot, networkProjectionConfig } from "./config";
import { getNetworkPlan, ProjectedNetworkGroup } from "./desired-state";

const NETWORK_ALLOCATION_ADVISORY_LOCK = 1447838018; // ASCII "VLAB" as a 32-bit key.

export class NetworkAllocationError extends Error {}

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

export async function allocateNetworkGroup(groupId: number): Promise<NetworkGroup> {
    const client = await pool.connect();
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