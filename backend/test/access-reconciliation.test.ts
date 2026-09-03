// -----------------------------------------------------------
//  [*] Tests — planAccess checks and actions
//
//  How one host observation grades against the
//  infrastructure plan, and which actions drift produces.
//
//  Covers src/network/adapters/access.ts. Run with `npm
//  test` (the whole suite) inside the backend container.
// -----------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import { buildOperationalAccessPlan } from "../src/network/access-desired-state";
import { planAccess } from "../src/network/adapters/access";
import { buildInfrastructurePlan } from "../src/network/infrastructure-desired-state";

const infrastructurePlan = buildInfrastructurePlan([{
    id: 2,
    owner_id: "student-2",
    profile_id: 1,
    profile_name: "Default",
    domains: [],
    state: "creating",
    vlan_tag: 2002,
    vnet_name: "lab2002",
    subnet_cidr: "10.200.2.0/24",
}]);
const accessPlan = buildOperationalAccessPlan({
    groups: [{ group_id: 2, vlan_tag: 2002, subnet_cidr: "10.200.2.0/24" }],
    trunk_vlan_ids: [2000, 2002],
    docker_bridge_cidrs: ["172.18.0.0/16"],
});
const observation = {
    version: 1 as const,
    request_id: "00000000-0000-4000-8000-000000000001",
    target: "access" as const,
    operation: "observe" as const,
    captured_at: "2026-08-07T09:00:00Z",
    vmid: 200 as const,
    status: "running" as const,
    config_digest: "a".repeat(40),
    net1: { name: "eth1", bridge: "vmbr20", ip: "10.10.20.10/24", trunks: [2002, 2000] },
    host_veth: { name: "veth200i1" as const, exists: true, vlan_ids: [2000, 2002] },
    guest: {
        version: 1 as const,
        captured_at: "2026-08-07T09:00:00Z",
        hostname: "guacamole",
        interfaces: [
            { name: "eth0", addresses: ["10.10.10.50/24"] },
            { name: "eth1", addresses: [] },
            { name: "eth1.2002", addresses: ["10.200.2.2/24"] },
        ],
        docker_bridge_cidrs: ["172.18.0.0/16"],
        listeners: [
            { port: 8080, local_address: "10.10.10.50" },
            { port: 9443, local_address: "10.10.10.50" },
        ],
        connections: [],
        sysctl: { ipv4_forwarding: true, ipv6_enabled: false },
        nftables: {
            available: true,
            ruleset: `# Access desired-state revision ${accessPlan.revision}`,
        },
        errors: [],
    },
    errors: [],
};

test("plans no Access updates for converged persistent, live, and guest state", () => {
    const result = planAccess(infrastructurePlan, observation);

    assert.deepEqual(result.actions, []);
    assert.equal(result.checks.find(({ key }) => key === "access-persistent-trunks")?.status, "pass");
    assert.equal(result.checks.find(({ key }) => key === "access-live-trunks")?.status, "pass");
    const sourceChecks = result.checks.filter(({ key }) => key.endsWith("-source"));
    assert.ok(sourceChecks.every(({ status, required }) => status === "unobserved" && !required));
});

test("plans persistent and live trunk updates independently", () => {
    const persistent = planAccess(infrastructurePlan, {
        ...observation,
        net1: { ...observation.net1, trunks: [2000] },
    });
    const live = planAccess(infrastructurePlan, {
        ...observation,
        host_veth: { ...observation.host_veth, vlan_ids: [2000] },
    });

    assert.deepEqual(persistent.actions.map(({ resource }) => resource), ["lxc/200/net1"]);
    assert.deepEqual(live.actions.map(({ resource }) => resource), ["bridge/veth200i1/vlans"]);
});

test("an extra trunk VLAN mid-teardown is pruned, not treated as a blocker", () => {
    // Regression, and the reason group teardown could never complete: teardown
    // marks a group `deleting` before it touches any appliance, so the desired
    // trunk list shrinks while the Access appliance is still carrying the VLAN.
    // These two checks are `required` and not in ACCESS_APPLY_FIXABLE_CHECKS, so
    // failing them blocked the Access policy apply -- the step teardown runs
    // next, and the one that runs before the trunk step that prunes the extra.
    const result = planAccess(infrastructurePlan, {
        ...observation,
        net1: { ...observation.net1, trunks: [2000, 2002, 2007] },
        host_veth: { ...observation.host_veth, vlan_ids: [2000, 2002, 2007] },
    });

    assert.equal(result.checks.find(({ key }) => key === "access-persistent-trunks")?.status, "pass");
    assert.equal(result.checks.find(({ key }) => key === "access-live-trunks")?.status, "pass");

    // Tolerated for the gate, still planned away: the extra VLAN is reported and
    // pruned, it just no longer bars every other Access change behind it.
    assert.deepEqual(
        result.actions.map(({ resource }) => resource).sort(),
        ["bridge/veth200i1/vlans", "lxc/200/net1"],
    );
});

test("a trunk missing a desired VLAN still fails closed", () => {
    // The dangerous direction, and the one these checks exist for: policy
    // written for a VLAN the trunk cannot carry silently never takes effect.
    const persistent = planAccess(infrastructurePlan, {
        ...observation,
        net1: { ...observation.net1, trunks: [2000] },
    });
    const live = planAccess(infrastructurePlan, {
        ...observation,
        host_veth: { ...observation.host_veth, vlan_ids: [2000] },
    });

    assert.equal(persistent.checks.find(({ key }) => key === "access-persistent-trunks")?.status, "fail");
    assert.equal(live.checks.find(({ key }) => key === "access-live-trunks")?.status, "fail");
});

test("fails closed for malformed topology and plans guest drift", () => {
    assert.throws(
        () => planAccess(infrastructurePlan, { ...observation, vmid: 201 }),
        /Invalid input/,
    );
    const result = planAccess(infrastructurePlan, {
        ...observation,
        guest: {
            ...observation.guest,
            interfaces: observation.guest.interfaces.filter(({ name }) => name !== "eth1.2002"),
        },
    });
    assert.deepEqual(result.actions.map(({ resource }) => resource), [
        "lxc/200/guest-network-policy",
    ]);
});