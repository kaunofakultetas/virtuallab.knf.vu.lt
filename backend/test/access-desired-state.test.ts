// -----------------------------------------------------------
//  [*] Tests — the Access desired-state builder
//
//  Canonical subnet/VLAN validation, trunk allowlists, and
//  the hashed plan revision.
//
//  Covers src/network/access-desired-state.ts. Run with `npm
//  test` (the whole suite) inside the backend container.
// -----------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import {
    AccessGroupInput,
    buildAccessPlan,
    buildOperationalAccessPlan,
} from "../src/network/access-desired-state";

const activeGroup = {
    group_id: 7,
    state: "active" as const,
    vlan_tag: 2007,
    subnet_cidr: "10.200.7.0/24",
};

test("renders canonical active-only Access state", () => {
    const first = buildAccessPlan({
        groups: [
            activeGroup,
            {
                group_id: 3,
                state: "active",
                vlan_tag: 2003,
                subnet_cidr: "10.200.3.0/24",
            },
            {
                group_id: 1,
                state: "planned",
                vlan_tag: null,
                subnet_cidr: null,
            },
        ],
        docker_bridge_cidrs: ["172.18.0.0/16"],
    });
    const second = buildAccessPlan({
        groups: ([activeGroup, {
            group_id: 3,
            state: "active",
            vlan_tag: 2003,
            subnet_cidr: "10.200.3.0/24",
        }] satisfies AccessGroupInput[]).reverse(),
        docker_bridge_cidrs: ["172.18.0.0/16"],
    });

    assert.equal(first.revision, second.revision);
    assert.deepEqual(first.desired_state.management.allowed_sources, ["10.10.10.100/32"]);
    assert.deepEqual(first.desired_state.transport.trunk_vlan_ids, [2003, 2007]);
    assert.equal(first.desired_state.transport.trunk_allowlist, "2003;2007");
    assert.deepEqual(first.desired_state.transport.interfaces, [
        {
            group_id: 3,
            vlan_tag: 2003,
            interface_name: "eth1.2003",
            subnet_cidr: "10.200.3.0/24",
            address_cidr: "10.200.3.2/24",
        },
        {
            group_id: 7,
            vlan_tag: 2007,
            interface_name: "eth1.2007",
            subnet_cidr: "10.200.7.0/24",
            address_cidr: "10.200.7.2/24",
        },
    ]);
});

test("rejects incomplete, duplicate, and out-of-pool active allocations", () => {
    const input = {
        docker_bridge_cidrs: ["172.18.0.0/16"],
    };

    assert.throws(
        () => buildAccessPlan({ ...input, groups: [{ ...activeGroup, vlan_tag: null }] }),
        /has no persisted VLAN\/subnet allocation/,
    );
    assert.throws(
        () => buildAccessPlan({ ...input, groups: [activeGroup, { ...activeGroup, group_id: 8 }] }),
        /duplicate VLAN allocations/,
    );
    assert.throws(
        () => buildAccessPlan({ ...input, groups: [{ ...activeGroup, vlan_tag: 2256 }] }),
        /outside the approved pool/,
    );
    assert.throws(
        () => buildAccessPlan({ ...input, groups: [{ ...activeGroup, subnet_cidr: "10.200.8.0/24" }] }),
        /subnet does not match VLAN 2007/,
    );
});

test("renders an explicit empty trunk when no groups are active", () => {
    const plan = buildAccessPlan({
        groups: [{
            group_id: 1,
            state: "planned",
            vlan_tag: null,
            subnet_cidr: null,
        }],
        docker_bridge_cidrs: [],
    });

    assert.deepEqual(plan.desired_state.transport.trunk_vlan_ids, []);
    assert.equal(plan.desired_state.transport.trunk_allowlist, "");
    assert.deepEqual(plan.desired_state.transport.interfaces, []);
});

test("rejects invalid Docker CIDRs", () => {
    assert.throws(
        () => buildAccessPlan({
            groups: [],
            docker_bridge_cidrs: ["2001:db8::/64"],
        }),
        /Docker bridge must be a valid IPv4 CIDR/,
    );
});

test("keeps migration-only trunks separate from operational interfaces", () => {
    const migrationOnly = buildOperationalAccessPlan({
        groups: [],
        trunk_vlan_ids: [2000],
        docker_bridge_cidrs: ["172.18.0.0/16"],
    });
    const operational = buildOperationalAccessPlan({
        groups: [{
            group_id: 2,
            vlan_tag: 2002,
            subnet_cidr: "10.200.2.0/24",
        }],
        trunk_vlan_ids: [2002, 2000, 2002],
        docker_bridge_cidrs: ["172.18.0.0/16"],
    });

    assert.deepEqual(migrationOnly.desired_state.transport.trunk_vlan_ids, [2000]);
    assert.deepEqual(migrationOnly.desired_state.transport.interfaces, []);
    assert.deepEqual(operational.desired_state.transport.trunk_vlan_ids, [2000, 2002]);
    assert.deepEqual(
        operational.desired_state.transport.interfaces.map(({ interface_name }) => interface_name),
        ["eth1.2002"],
    );
});

test("requires operational interfaces to be present in the Access trunk", () => {
    assert.throws(
        () => buildOperationalAccessPlan({
            groups: [{
                group_id: 2,
                vlan_tag: 2002,
                subnet_cidr: "10.200.2.0/24",
            }],
            trunk_vlan_ids: [2000],
            docker_bridge_cidrs: [],
        }),
        /must include every desired VLAN interface/,
    );
});