// -----------------------------------------------------------
//  [*] Network — policy tables: allowed domains, peerings
//
//  Administration of the two policy inputs that are not
//  derived from anything: which web domains a profile may
//  reach, and which groups may talk to each other.
//
//  Both are edited here and nowhere else, so validation
//  lives in one place. The database is authoritative;
//  nothing in this file touches infrastructure. A change
//  becomes real when the next reconciliation renders it,
//  which is the same path provisioning and teardown use.
//
//  Used by:
//    - network.route.ts — the policy admin endpoints
//    - test/network-policy.test.ts
// -----------------------------------------------------------

import { pool } from "@/utils/db";
import { z } from "zod";

export class NetworkPolicyError extends Error {}








// -----------------------------------------------------------
// domainSchema / allowedDomainSchema
// -----------------------------------------------------------
//
// A hostname, not a URL and not a pattern.
//
// Squid is handed these as `dstdomain` and
// `ssl::server_name` values with a leading dot for
// subdomain matches, so anything carrying a scheme, a path,
// a port or a wildcard would either widen the allowlist or
// fail to parse on the Gateway — after the apply, where it
// is expensive to discover. Matches the database CHECK
// constraints rather than restating them loosely.
//
// Used by:
//   - network.route.ts — validating POST bodies
//   - addAllowedDomain (below)
// -----------------------------------------------------------

export const domainSchema = z
    .string()
    .min(1)
    .max(253)
    .transform((value) => value.trim().toLowerCase())
    .refine((value) => !/[/:\s]/.test(value), "A domain carries no scheme, port or path")
    .refine((value) => !value.startsWith(".") && !value.endsWith("."), "No leading or trailing dot")
    .refine((value) => !value.includes("*"), "Wildcards are expressed by include_subdomains")
    .refine(
        (value) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value),
        "Not a valid domain name",
    );

export const allowedDomainSchema = z.object({
    domain: domainSchema,
    include_subdomains: z.boolean().default(true),
}).strict();

export type AllowedWebDomain = {
    profile_id: number;
    domain: string;
    include_subdomains: boolean;
};








// -----------------------------------------------------------
// listAllowedDomains
// -----------------------------------------------------------
//
// Used by:
//   - network.route.ts — GET .../domains
// -----------------------------------------------------------

export async function listAllowedDomains(profileId: number): Promise<AllowedWebDomain[]> {
    const result = await pool.query<AllowedWebDomain>(
        `SELECT profile_id, domain, include_subdomains
         FROM allowed_web_domains
         WHERE profile_id = $1
         ORDER BY domain`,
        [profileId],
    );
    return result.rows;
}








// -----------------------------------------------------------
// addAllowedDomain
// -----------------------------------------------------------
//
// Upserts rather than inserts, so re-adding a domain to
// flip `include_subdomains` is not a conflict an admin has
// to resolve by deleting first.
//
// Used by:
//   - network.route.ts — POST .../domains
// -----------------------------------------------------------

export async function addAllowedDomain(
    profileId: number,
    input: z.infer<typeof allowedDomainSchema>,
): Promise<AllowedWebDomain> {
    const result = await pool.query<AllowedWebDomain>(
        `INSERT INTO allowed_web_domains (profile_id, domain, include_subdomains)
         VALUES ($1, $2, $3)
         ON CONFLICT (profile_id, domain) DO UPDATE
         SET include_subdomains = EXCLUDED.include_subdomains
         RETURNING profile_id, domain, include_subdomains`,
        [profileId, input.domain, input.include_subdomains],
    );
    return result.rows[0];
}








// -----------------------------------------------------------
// removeAllowedDomain
// -----------------------------------------------------------
//
// Used by:
//   - network.route.ts — DELETE .../domains/:domain
// -----------------------------------------------------------

export async function removeAllowedDomain(
    profileId: number,
    domain: string,
): Promise<boolean> {
    const result = await pool.query(
        "DELETE FROM allowed_web_domains WHERE profile_id = $1 AND domain = $2",
        [profileId, domain.trim().toLowerCase()],
    );
    return (result.rowCount ?? 0) > 0;
}


export type GroupPeering = {
    group_a_id: number;
    group_b_id: number;
};








// -----------------------------------------------------------
// listGroupPeerings
// -----------------------------------------------------------
//
// Used by:
//   - network.route.ts — GET /peerings
// -----------------------------------------------------------

export async function listGroupPeerings(): Promise<GroupPeering[]> {
    const result = await pool.query<GroupPeering>(
        "SELECT group_a_id, group_b_id FROM group_peerings ORDER BY group_a_id, group_b_id",
    );
    return result.rows;
}








// -----------------------------------------------------------
// orderPeering
// -----------------------------------------------------------
//
// Peering is undirected, and the table enforces
// `group_a_id < group_b_id`.
//
// Ordering the pair here rather than rejecting an
// out-of-order one means `(7, 4)` and `(4, 7)` are the same
// peering, which is what an admin means. Not doing so would
// let the same relationship be stored twice under two keys,
// and removing one would leave the other rendering rules
// for a peering the admin believed they had deleted.
//
// Used by:
//   - addGroupPeering, removeGroupPeering (below)
// -----------------------------------------------------------

export function orderPeering(groupAId: number, groupBId: number): GroupPeering {
    if (!Number.isInteger(groupAId) || !Number.isInteger(groupBId)) {
        throw new NetworkPolicyError("Peering group IDs must be integers");
    }
    if (groupAId === groupBId) {
        throw new NetworkPolicyError("A group cannot be peered with itself");
    }
    return groupAId < groupBId
        ? { group_a_id: groupAId, group_b_id: groupBId }
        : { group_a_id: groupBId, group_b_id: groupAId };
}








// -----------------------------------------------------------
// addGroupPeering
// -----------------------------------------------------------
//
// Used by:
//   - network.route.ts — POST /peerings
// -----------------------------------------------------------

export async function addGroupPeering(
    groupAId: number,
    groupBId: number,
): Promise<GroupPeering> {
    const pair = orderPeering(groupAId, groupBId);
    const result = await pool.query<GroupPeering>(
        `INSERT INTO group_peerings (group_a_id, group_b_id)
         VALUES ($1, $2)
         ON CONFLICT (group_a_id, group_b_id) DO NOTHING
         RETURNING group_a_id, group_b_id`,
        [pair.group_a_id, pair.group_b_id],
    );
    // DO NOTHING returns no row when the peering already exists, which is a
    // successful outcome for an idempotent add rather than a missing result.
    return result.rows[0] ?? pair;
}








// -----------------------------------------------------------
// removeGroupPeering
// -----------------------------------------------------------
//
// Used by:
//   - network.route.ts — DELETE /peerings/:aId/:bId
// -----------------------------------------------------------

export async function removeGroupPeering(
    groupAId: number,
    groupBId: number,
): Promise<boolean> {
    const pair = orderPeering(groupAId, groupBId);
    const result = await pool.query(
        "DELETE FROM group_peerings WHERE group_a_id = $1 AND group_b_id = $2",
        [pair.group_a_id, pair.group_b_id],
    );
    return (result.rowCount ?? 0) > 0;
}
