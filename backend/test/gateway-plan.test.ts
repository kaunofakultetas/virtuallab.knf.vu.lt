// -----------------------------------------------------------
//  [*] Tests — the Gateway plan's database half
//
//  Fail-closed runtime settings and the operational
//  group/peering queries feeding buildGatewayPlan.
//
//  Covers src/network/gateway-plan.ts. Run with `npm test`
//  (the whole suite) inside the backend container.
// -----------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import {
    GatewayPlanQuery,
    GatewayRuntimeSettings,
    getGatewayPlan,
    getGroupPeerings,
} from "../src/network/gateway-plan";

function settings(): GatewayRuntimeSettings {
    return {
        trunk_interface: "ens19",
        uplink_interface: "ens20",
        management_interface: "ens18",
        upstream_resolvers: ["1.1.1.1"],
    };
}

/**
 * Answers each SQL statement by matching a distinctive fragment, so the tests
 * do not depend on exact whitespace.
 */
function fakeQueryable(rowsBySignature: Array<[string, unknown[]]>): GatewayPlanQuery & {
    statements: string[];
} {
    const statements: string[] = [];
    return {
        statements,
        async query(queryText: string) {
            statements.push(queryText);
            for (const [signature, rows] of rowsBySignature) {
                if (queryText.includes(signature)) {
                    return { rows } as never;
                }
            }
            return { rows: [] } as never;
        },
    };
}

test("assembles a plan from operational groups, domains, and peerings", async () => {
    const queryable = fakeQueryable([
        ["FROM network_groups network_group", [
            {
                id: 1,
                vlan_tag: 2000,
                subnet_cidr: "10.200.0.0/24",
                allowed_web_domains: [
                    { domain: "archive.ubuntu.com", include_subdomains: true },
                ],
            },
            {
                id: 2,
                vlan_tag: 2001,
                subnet_cidr: "10.200.1.0/24",
                allowed_web_domains: [],
            },
        ]],
        ["FROM group_peerings peering", [{ group_a_id: 1, group_b_id: 2 }]],
    ]);

    const plan = await getGatewayPlan({ queryable, getSettings: async () => settings() });

    assert.deepEqual(
        plan.desired_state.transport.interfaces.map((entry) => entry.interface_name),
        ["ens19.2000", "ens19.2001"],
    );
    assert.deepEqual(
        plan.desired_state.transport.interfaces[0].allowed_web_domains,
        [{ domain: "archive.ubuntu.com", include_subdomains: true }],
    );
    // One undirected peering becomes two directed edges.
    assert.equal(plan.desired_state.peerings.length, 2);
});

test("tolerates a group with no domain rows", async () => {
    const queryable = fakeQueryable([
        ["FROM network_groups network_group", [
            { id: 1, vlan_tag: 2000, subnet_cidr: "10.200.0.0/24", allowed_web_domains: null },
        ]],
    ]);

    const plan = await getGatewayPlan({ queryable, getSettings: async () => settings() });
    assert.deepEqual(plan.desired_state.transport.interfaces[0].allowed_web_domains, []);
});

test("produces an empty transport when no group is operational", async () => {
    const queryable = fakeQueryable([]);

    const plan = await getGatewayPlan({ queryable, getSettings: async () => settings() });

    assert.deepEqual(plan.desired_state.transport.interfaces, []);
    assert.deepEqual(plan.desired_state.peerings, []);
});

test("restricts peerings to groups that both hold an allocation", async () => {
    const queryable = fakeQueryable([["FROM group_peerings peering", []]]);
    await getGroupPeerings(queryable);

    const [statement] = queryable.statements;
    // A peering pointing at a still-planned group is not realisable and must be
    // filtered in SQL rather than failing the whole plan.
    assert.match(statement, /a\.vlan_tag IS NOT NULL/);
    assert.match(statement, /b\.vlan_tag IS NOT NULL/);
});

test("selects the same operational states as the infrastructure plan", async () => {
    const queryable = fakeQueryable([]);
    await getGatewayPlan({ queryable, getSettings: async () => settings() });

    const groupStatement = queryable.statements.find((text) =>
        text.includes("FROM network_groups network_group"));
    assert.ok(groupStatement);
    assert.match(groupStatement, /state IN \('creating', 'active'\)/);
    assert.match(groupStatement, /state = 'error' AND network_group\.vlan_tag IS NOT NULL/);
});

test("fails closed when the Gateway interface names are unconfigured", async () => {
    const queryable = fakeQueryable([]);

    await assert.rejects(
        getGatewayPlan({
            queryable,
            getSettings: async () => ({ ...settings(), trunk_interface: "" }),
        }),
        /not a valid interface name/,
    );
});
