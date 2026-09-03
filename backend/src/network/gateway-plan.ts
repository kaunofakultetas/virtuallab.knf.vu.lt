// -----------------------------------------------------------
//  [*] Network — assembling the Gateway plan from the DB
//
//  The database half of Gateway desired state: the recorded
//  runtime settings (interface names, resolvers — facts the
//  DB cannot derive, read fail-closed), the operational
//  group rows with their domain lists, and the realisable
//  peerings. buildGatewayPlan in gateway-desired-state.ts
//  turns all of it into the hashed plan.
//
//  Used by:
//    - gateway-apply-runner.ts, provisioning-network.ts,
//      drift-reconciler.ts — the plan
//    - readiness.ts — getGatewayRuntimeSettings
//    - provisioning-firewall.ts — getPeerSubnetCidrs
//    - scripts/renderGatewayConfiguration.ts,
//      setGatewayRuntimeSettings.ts
// -----------------------------------------------------------

import { QueryResult, QueryResultRow } from "pg";
import { pool } from "@/utils/db";
import { metadata } from "@/utils/metadata";
import { networkProjectionConfig } from "./config";
import {
    buildGatewayPlan,
    GatewayAllowedDomain,
    GatewayPeeringInput,
    GatewayPlan,
} from "./gateway-desired-state";

export class GatewayConfigurationError extends Error {}

// Runtime facts about the built Gateway VM that the database cannot derive.
//
// The guest's interface names depend on the image and NIC layout, so they are
// recorded once the VM exists rather than guessed. Every key is empty by
// default and reading them fails closed, because rendering policy against
// invented interface names would produce plausible but wrong configuration.
export const GATEWAY_SETTING_KEYS = {
    trunkInterface: "settings.network.gateway.trunkInterface",
    uplinkInterface: "settings.network.gateway.uplinkInterface",
    managementInterface: "settings.network.gateway.managementInterface",
    upstreamResolvers: "settings.network.gateway.upstreamResolvers",
} as const;

export type GatewayRuntimeSettings = {
    trunk_interface: string;
    uplink_interface: string;
    management_interface: string;
    upstream_resolvers: string[];
};

type GatewayGroupRow = {
    id: number;
    vlan_tag: number;
    subnet_cidr: string;
    allowed_web_domains: GatewayAllowedDomain[];
};

export type GatewayPlanQuery = {
    query<Row extends QueryResultRow = QueryResultRow>(
        queryText: string,
        values?: unknown[],
    ): Promise<QueryResult<Row>>;
};

export type GatewayPlanDependencies = {
    queryable?: GatewayPlanQuery;
    getSettings?: () => Promise<GatewayRuntimeSettings>;
};


function requireSetting(value: unknown, key: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new GatewayConfigurationError(
            `${key} is not configured; record it from the built Gateway VM before rendering policy`,
        );
    }
    return value.trim();
}








// -----------------------------------------------------------
// getGatewayRuntimeSettings
// -----------------------------------------------------------
//
// Reads the four gateway.* settings, refusing empty or
// missing values — see the GATEWAY_SETTING_KEYS comment.
//
// Used by:
//   - getGatewayPlan (below), readiness.ts,
//     scripts/setGatewayRuntimeSettings.ts
// -----------------------------------------------------------

export async function getGatewayRuntimeSettings(): Promise<GatewayRuntimeSettings> {
    const [trunk, uplink, management, resolvers] = await Promise.all([
        metadata.get(GATEWAY_SETTING_KEYS.trunkInterface),
        metadata.get(GATEWAY_SETTING_KEYS.uplinkInterface),
        metadata.get(GATEWAY_SETTING_KEYS.managementInterface),
        metadata.get(GATEWAY_SETTING_KEYS.upstreamResolvers),
    ]);

    if (!Array.isArray(resolvers) || resolvers.length === 0) {
        throw new GatewayConfigurationError(
            `${GATEWAY_SETTING_KEYS.upstreamResolvers} must list at least one resolver`,
        );
    }

    return {
        trunk_interface: requireSetting(trunk, GATEWAY_SETTING_KEYS.trunkInterface),
        uplink_interface: requireSetting(uplink, GATEWAY_SETTING_KEYS.uplinkInterface),
        management_interface: requireSetting(
            management,
            GATEWAY_SETTING_KEYS.managementInterface,
        ),
        upstream_resolvers: resolvers.map((resolver, index) => requireSetting(
            resolver,
            `${GATEWAY_SETTING_KEYS.upstreamResolvers}[${index}]`,
        )),
    };
}


// Groups that may hold infrastructure, matching the infrastructure plan's own
// definition: `creating` and `active`, plus `error` rows that still hold an
// allocation so their resources remain represented until teardown.
const OPERATIONAL_GROUPS_SQL = `
    SELECT
        network_group.id,
        network_group.vlan_tag,
        network_group.subnet_cidr::text AS subnet_cidr,
        COALESCE(
            json_agg(
                json_build_object(
                    'domain', domain.domain,
                    'include_subdomains', domain.include_subdomains
                )
                ORDER BY domain.domain
            ) FILTER (WHERE domain.domain IS NOT NULL),
            '[]'::json
        ) AS allowed_web_domains
    FROM network_groups network_group
    JOIN lab_profiles profile ON profile.id = network_group.profile_id
    LEFT JOIN allowed_web_domains domain ON domain.profile_id = profile.id
    WHERE network_group.state IN ('creating', 'active')
       OR (network_group.state = 'error' AND network_group.vlan_tag IS NOT NULL)
    GROUP BY network_group.id
    ORDER BY network_group.id
`;

// Only peerings where BOTH sides currently hold an allocation are realisable.
//
// A peering that references a still-`planned` group is a legitimate transient
// state, not a misconfiguration, so it is omitted from desired state rather
// than failing the whole plan.
const OPERATIONAL_PEERINGS_SQL = `
    SELECT peering.group_a_id, peering.group_b_id
    FROM group_peerings peering
    JOIN network_groups a ON a.id = peering.group_a_id
    JOIN network_groups b ON b.id = peering.group_b_id
    WHERE a.vlan_tag IS NOT NULL
      AND b.vlan_tag IS NOT NULL
      AND (a.state IN ('creating', 'active') OR a.state = 'error')
      AND (b.state IN ('creating', 'active') OR b.state = 'error')
    ORDER BY peering.group_a_id, peering.group_b_id
`;

// Subnets of the groups a given group is peered with.
//
// Undirected, so both columns are matched: a peering stored as (4, 7) has to be
// visible from group 7 as well, or one side of an approved pair would be
// admitted while the other was silently dropped.
//
// Only allocated, operational peers are returned, for the same reason
// `OPERATIONAL_PEERINGS_SQL` filters them: a peer without a subnet has no
// address range to admit, and rendering one would produce a rule matching
// nothing or, worse, a malformed one.
const PEER_SUBNETS_SQL = `
    SELECT peer.subnet_cidr::text AS subnet_cidr
    FROM group_peerings peering
    JOIN network_groups peer
      ON peer.id = CASE
          WHEN peering.group_a_id = $1 THEN peering.group_b_id
          ELSE peering.group_a_id
      END
    WHERE ($1 IN (peering.group_a_id, peering.group_b_id))
      AND peer.subnet_cidr IS NOT NULL
      AND peer.state IN ('creating', 'active', 'error')
    ORDER BY peer.subnet_cidr
`;








// -----------------------------------------------------------
// getPeerSubnetCidrs
// -----------------------------------------------------------
//
// Used by:
//   - provisioning-firewall.ts — the VM policy's peer list
// -----------------------------------------------------------

export async function getPeerSubnetCidrs(
    groupId: number,
    queryable: GatewayPlanQuery = pool,
): Promise<string[]> {
    const result = await queryable.query<{ subnet_cidr: string }>(PEER_SUBNETS_SQL, [groupId]);
    return result.rows.map(({ subnet_cidr }) => subnet_cidr);
}








// -----------------------------------------------------------
// getGroupPeerings
// -----------------------------------------------------------
//
// Used by:
//   - getGatewayPlan (below)
// -----------------------------------------------------------

export async function getGroupPeerings(
    queryable: GatewayPlanQuery = pool,
): Promise<GatewayPeeringInput[]> {
    const result = await queryable.query<GatewayPeeringInput>(OPERATIONAL_PEERINGS_SQL);
    return result.rows;
}








// -----------------------------------------------------------
// getGatewayPlan
// -----------------------------------------------------------
//
// Settings, groups and peerings in parallel, then the pure
// plan builder.
//
// Used by:
//   - gateway-apply-runner.ts, provisioning-network.ts,
//     drift-reconciler.ts, scripts/renderGatewayConfiguration.ts
// -----------------------------------------------------------

export async function getGatewayPlan(
    dependencies: GatewayPlanDependencies = {},
): Promise<GatewayPlan> {
    const queryable = dependencies.queryable ?? pool;
    const loadSettings = dependencies.getSettings ?? getGatewayRuntimeSettings;

    const [settings, groups, peerings] = await Promise.all([
        loadSettings(),
        queryable.query<GatewayGroupRow>(OPERATIONAL_GROUPS_SQL),
        getGroupPeerings(queryable),
    ]);

    return buildGatewayPlan({
        groups: groups.rows.map((row) => ({
            group_id: row.id,
            vlan_tag: row.vlan_tag,
            subnet_cidr: row.subnet_cidr,
            allowed_web_domains: row.allowed_web_domains ?? [],
        })),
        peerings,
        trunk_interface: settings.trunk_interface,
        uplink_interface: settings.uplink_interface,
        management_interface: settings.management_interface,
        upstream_resolvers: settings.upstream_resolvers,
        management_source_cidrs:
            networkProjectionConfig.infrastructure.gatewayManagementSourceCidrs,
    });
}
