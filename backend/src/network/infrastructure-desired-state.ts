import { createHash } from "node:crypto";
import { QueryResult, QueryResultRow } from "pg";
import { pool } from "@/utils/db";
import { NetworkGroupState } from "@/types/network-groups";
import { buildNetworkPlan, DesiredStateInputRow, ProjectedNetworkGroup } from "./desired-state";

export const ACCESS_MIGRATION_VLAN = 2000;

export type InfrastructureDesiredStateInputRow = DesiredStateInputRow & {
    state: NetworkGroupState;
};

export type InfrastructureVnet = {
    vnet: string;
    zone: string;
    tag: number;
};

export type InfrastructureDesiredState = {
    version: 1;
    migration: {
        preserved_access_vlans: number[];
    };
    groups: ProjectedNetworkGroup[];
    proxmox: {
        vnets: InfrastructureVnet[];
    };
    trunks: {
        access_vlan_ids: number[];
        gateway_vlan_ids: number[];
    };
};

export type InfrastructurePlan = {
    revision: string;
    desired_state: InfrastructureDesiredState;
};

export type InfrastructurePlanQuery = {
    query<Row extends QueryResultRow = QueryResultRow>(
        queryText: string,
        values?: unknown[],
    ): Promise<QueryResult<Row>>;
};

function isOperationalTarget(row: InfrastructureDesiredStateInputRow): boolean {
    if (row.state === "creating" || row.state === "active") {
        return true;
    }
    return row.state === "error" && row.vlan_tag !== null && row.vlan_tag !== undefined;
}

export function buildInfrastructurePlan(
    rows: InfrastructureDesiredStateInputRow[],
): InfrastructurePlan {
    const operationalRows = rows.filter(isOperationalTarget);
    for (const row of operationalRows) {
        if (row.vlan_tag === null || row.vlan_tag === undefined) {
            throw new Error(`Operational network group ${row.id} has no persisted allocation`);
        }
    }
    const networkPlan = buildNetworkPlan(operationalRows);
    const vlanIds = networkPlan.desired_state.groups.map(({ vlan_tag }) => vlan_tag);
    const accessVlanIds = [...new Set([ACCESS_MIGRATION_VLAN, ...vlanIds])].sort(
        (left, right) => left - right,
    );
    const desiredState: InfrastructureDesiredState = {
        version: 1,
        migration: {
            preserved_access_vlans: [ACCESS_MIGRATION_VLAN],
        },
        groups: networkPlan.desired_state.groups,
        proxmox: {
            vnets: networkPlan.desired_state.groups.map(({ vnet_name, vlan_tag }) => ({
                vnet: vnet_name,
                zone: networkPlan.desired_state.generated_from.config.proxmox.zone,
                tag: vlan_tag,
            })),
        },
        trunks: {
            access_vlan_ids: accessVlanIds,
            gateway_vlan_ids: [...vlanIds],
        },
    };

    return {
        revision: createHash("sha256").update(JSON.stringify(desiredState)).digest("hex"),
        desired_state: desiredState,
    };
}

export async function getInfrastructurePlan(
    queryable: InfrastructurePlanQuery = pool,
): Promise<InfrastructurePlan> {
    const result = await queryable.query<InfrastructureDesiredStateInputRow>(`
        SELECT
            network_group.id,
            network_group.owner_id,
            network_group.profile_id,
            network_group.vlan_tag,
            network_group.vnet_name,
            network_group.subnet_cidr::text AS subnet_cidr,
            network_group.state,
            profile.name AS profile_name,
            COALESCE(
                array_agg(domain.domain ORDER BY domain.domain)
                    FILTER (WHERE domain.domain IS NOT NULL),
                ARRAY[]::text[]
            ) AS domains
        FROM network_groups network_group
        JOIN lab_profiles profile ON profile.id = network_group.profile_id
        LEFT JOIN allowed_web_domains domain ON domain.profile_id = profile.id
        WHERE network_group.state IN ('creating', 'active')
           OR network_group.state = 'error' AND network_group.vlan_tag IS NOT NULL
        GROUP BY network_group.id, profile.name
        ORDER BY network_group.id
    `);
    return buildInfrastructurePlan(result.rows);
}