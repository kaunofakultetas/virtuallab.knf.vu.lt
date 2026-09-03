// -----------------------------------------------------------
//  [*] Network — the network plan: groups → projected slots
//
//  Projects every network group onto its canonical slot. A
//  group with a persisted allocation keeps it (after strict
//  canonical-form checks); a group without one is projected
//  onto the lowest free VLAN — a PROJECTION only, nothing is
//  written back. The plan's revision is a sha256 over the
//  whole desired state.
//
//  Used by:
//    - network.route.ts — GET /network/plan
//    - instances.route.ts — the dry-run projection log
//    - infrastructure-desired-state.ts, groups.ts,
//      readiness.ts
// -----------------------------------------------------------

import { createHash } from "node:crypto";
import { QueryResult, QueryResultRow } from "pg";
import { pool } from "@/utils/db";
import {
    getNetworkSlot,
    networkProjectionConfig,
    NetworkProjectionConfig,
    NetworkSlot,
    validateNetworkProjectionConfig,
} from "./config";

export type DesiredStateInputRow = {
    id: number;
    owner_id: string;
    profile_id: number;
    profile_name: string;
    domains: string[] | null;
    vlan_tag?: number | null;
    vnet_name?: string | null;
    subnet_cidr?: string | null;
};

export type ProjectedNetworkGroup = {
    group_id: number;
    owner_id: string;
    profile_id: number;
    profile_name: string;
    vlan_tag: number;
    vnet_name: string;
    subnet_cidr: string;
    gateway_ip: string;
    access_ip: string;
    dhcp_range: {
        first: string;
        last: string;
    };
    allowed_web_domains: string[];
};

export type NetworkDesiredState = {
    version: 1;
    generated_from: {
        group_count: number;
        config: NetworkProjectionConfig;
    };
    groups: ProjectedNetworkGroup[];
};

export type NetworkPlan = {
    revision: string;
    desired_state: NetworkDesiredState;
};

export type NetworkPlanQuery = {
    query<Row extends QueryResultRow = QueryResultRow>(
        queryText: string,
        values?: unknown[],
    ): Promise<QueryResult<Row>>;
};


function buildGroupProjection(
    row: DesiredStateInputRow,
    slot: NetworkSlot,
): ProjectedNetworkGroup {
    return {
        group_id: row.id,
        owner_id: row.owner_id,
        profile_id: row.profile_id,
        profile_name: row.profile_name,
        vlan_tag: slot.vlanTag,
        vnet_name: slot.vnetName,
        subnet_cidr: slot.subnetCidr,
        gateway_ip: slot.gatewayIp,
        access_ip: slot.accessIp,
        dhcp_range: {
            first: slot.dhcpFirstIp,
            last: slot.dhcpLastIp,
        },
        allowed_web_domains: [...(row.domains ?? [])].sort(),
    };
}


// A persisted allocation is all-or-nothing, and must match the VLAN's
// canonical slot exactly — a partial or non-canonical row means the database
// and the projection disagree, and planning from either would be a guess.
function getPersistedSlot(
    row: DesiredStateInputRow,
    config: NetworkProjectionConfig,
): NetworkSlot | null {
    const fields = [row.vlan_tag, row.vnet_name, row.subnet_cidr];
    const populatedCount = fields.filter((field) => field !== null && field !== undefined).length;
    if (populatedCount === 0) {
        return null;
    }
    if (populatedCount !== fields.length) {
        throw new Error(`Network group ${row.id} has a partial persisted allocation`);
    }

    const slot = getNetworkSlot(row.vlan_tag as number, config);
    if (row.vnet_name !== slot.vnetName || row.subnet_cidr !== slot.subnetCidr) {
        throw new Error(`Network group ${row.id} has a non-canonical persisted allocation`);
    }
    return slot;
}








// -----------------------------------------------------------
// buildNetworkPlan
// -----------------------------------------------------------
//
// Pure: rows → the plan. Persisted allocations are pinned
// first (duplicate VLANs are an error), then unallocated
// groups are projected onto the lowest free VLANs in ID
// order, so the projection is deterministic for a given set
// of rows.
//
// Used by:
//   - getNetworkPlan (below), infrastructure-desired-state
//   - test/network-desired-state.test.ts
// -----------------------------------------------------------

export function buildNetworkPlan(
    rows: DesiredStateInputRow[],
    config: NetworkProjectionConfig = networkProjectionConfig,
): NetworkPlan {
    validateNetworkProjectionConfig(config);
    const sortedRows = [...rows].sort((left, right) => left.id - right.id);
    const persistedSlots = new Map<number, NetworkSlot>();
    const occupiedVlans = new Set<number>();
    for (const row of sortedRows) {
        const slot = getPersistedSlot(row, config);
        if (!slot) {
            continue;
        }
        if (occupiedVlans.has(slot.vlanTag)) {
            throw new Error(`Network VLAN ${slot.vlanTag} is allocated more than once`);
        }
        persistedSlots.set(row.id, slot);
        occupiedVlans.add(slot.vlanTag);
    }

    let nextVlan = config.vlan.first;
    const groups = sortedRows.map((row) => {
        let slot = persistedSlots.get(row.id);
        if (!slot) {
            while (nextVlan <= config.vlan.last && occupiedVlans.has(nextVlan)) {
                nextVlan += 1;
            }
            if (nextVlan > config.vlan.last) {
                throw new Error(`Network projection pool exhausted at group ${row.id}`);
            }
            slot = getNetworkSlot(nextVlan, config);
            occupiedVlans.add(nextVlan);
            nextVlan += 1;
        }
        return buildGroupProjection(row, slot);
    });
    const desiredState: NetworkDesiredState = {
        version: 1,
        generated_from: {
            group_count: sortedRows.length,
            config,
        },
        groups,
    };
    const serialized = JSON.stringify(desiredState);
    return {
        revision: createHash("sha256").update(serialized).digest("hex"),
        desired_state: desiredState,
    };
}








// -----------------------------------------------------------
// getNetworkPlan
// -----------------------------------------------------------
//
// Reads EVERY network group (unlike the infrastructure
// plan's operational filter) with each profile's domains
// aggregated in, and builds the projection.
//
// Used by:
//   - network.route.ts, instances.route.ts, readiness.ts
// -----------------------------------------------------------

export async function getNetworkPlan(queryable: NetworkPlanQuery = pool): Promise<NetworkPlan> {
    const result = await queryable.query<DesiredStateInputRow>(`
        SELECT
            network_group.id,
            network_group.owner_id,
            network_group.profile_id,
            network_group.vlan_tag,
            network_group.vnet_name,
            network_group.subnet_cidr::text AS subnet_cidr,
            profile.name AS profile_name,
            COALESCE(
                array_agg(domain.domain ORDER BY domain.domain)
                    FILTER (WHERE domain.domain IS NOT NULL),
                ARRAY[]::text[]
            ) AS domains
        FROM network_groups network_group
        JOIN lab_profiles profile ON profile.id = network_group.profile_id
        LEFT JOIN allowed_web_domains domain ON domain.profile_id = profile.id
        GROUP BY network_group.id, profile.name
        ORDER BY network_group.id
    `);
    return buildNetworkPlan(result.rows);
}
