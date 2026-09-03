// -----------------------------------------------------------
//  [*] Tests — the network plan projection
//
//  Persisted allocations pinned, unallocated groups
//  projected onto the lowest free VLANs, deterministically.
//
//  Covers src/network/desired-state.ts. Run with `npm test`
//  (the whole suite) inside the backend container.
// -----------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import { buildNetworkPlan } from "../src/network/desired-state";

const firstGroup = {
    id: 7,
    owner_id: "student-7",
    profile_id: 2,
    profile_name: "Web lab",
    domains: ["z.example", "a.example"],
};

test("projects groups deterministically by ascending group ID", () => {
    const first = buildNetworkPlan([
        firstGroup,
        {
            id: 3,
            owner_id: "student-3",
            profile_id: 1,
            profile_name: "Default",
            domains: [],
        },
    ]);
    const second = buildNetworkPlan([
        firstGroup,
        {
            id: 3,
            owner_id: "student-3",
            profile_id: 1,
            profile_name: "Default",
            domains: [],
        },
    ].reverse());

    assert.equal(first.revision, second.revision);
    assert.deepEqual(first.desired_state.groups.map(({ group_id }) => group_id), [3, 7]);
    assert.deepEqual(first.desired_state.groups[0], {
        group_id: 3,
        owner_id: "student-3",
        profile_id: 1,
        profile_name: "Default",
        vlan_tag: 2000,
        vnet_name: "lab2000",
        subnet_cidr: "10.200.0.0/24",
        gateway_ip: "10.200.0.1",
        access_ip: "10.200.0.2",
        dhcp_range: {
            first: "10.200.0.25",
            last: "10.200.0.254",
        },
        allowed_web_domains: [],
    });
    assert.deepEqual(first.desired_state.groups[1].allowed_web_domains, [
        "a.example",
        "z.example",
    ]);
});

test("rejects a 257th projected group", () => {
    const groups = Array.from({ length: 257 }, (_, index) => ({
        ...firstGroup,
        id: index + 1,
        owner_id: `student-${index + 1}`,
    }));

    assert.throws(
        () => buildNetworkPlan(groups),
        /Network projection pool exhausted at group 257/,
    );
});

test("preserves persisted allocations and fills the lowest free slot", () => {
    const plan = buildNetworkPlan([
        {
            ...firstGroup,
            vlan_tag: 2001,
            vnet_name: "lab2001",
            subnet_cidr: "10.200.1.0/24",
        },
        {
            id: 3,
            owner_id: "student-3",
            profile_id: 1,
            profile_name: "Default",
            domains: [],
        },
    ]);

    assert.deepEqual(
        plan.desired_state.groups.map(({ group_id, vlan_tag }) => ({ group_id, vlan_tag })),
        [
            { group_id: 3, vlan_tag: 2000 },
            { group_id: 7, vlan_tag: 2001 },
        ],
    );
});

test("does not shift persisted groups when an earlier group is absent", () => {
    const plan = buildNetworkPlan([
        {
            ...firstGroup,
            vlan_tag: 2007,
            vnet_name: "lab2007",
            subnet_cidr: "10.200.7.0/24",
        },
    ]);

    assert.equal(plan.desired_state.groups[0].vlan_tag, 2007);
});

test("rejects partial and non-canonical persisted allocations", () => {
    assert.throws(
        () => buildNetworkPlan([{ ...firstGroup, vlan_tag: 2000 }]),
        /partial persisted allocation/,
    );
    assert.throws(
        () => buildNetworkPlan([{
            ...firstGroup,
            vlan_tag: 2000,
            vnet_name: "lab2001",
            subnet_cidr: "10.200.0.0\/24",
        }]),
        /non-canonical persisted allocation/,
    );
});

test("rejects duplicate persisted VLAN slots", () => {
    assert.throws(
        () => buildNetworkPlan([
            {
                ...firstGroup,
                vlan_tag: 2000,
                vnet_name: "lab2000",
                subnet_cidr: "10.200.0.0/24",
            },
            {
                ...firstGroup,
                id: 8,
                owner_id: "student-8",
                vlan_tag: 2000,
                vnet_name: "lab2000",
                subnet_cidr: "10.200.0.0/24",
            },
        ]),
        /VLAN 2000 is allocated more than once/,
    );
});