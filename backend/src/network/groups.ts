import { NetworkGroup } from "@/types/network-groups";
import { pool } from "@/utils/db";

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