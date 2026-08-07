import assert from "node:assert/strict";
import test from "node:test";
import { buildInfrastructurePlan } from "../src/network/infrastructure-desired-state";
import { planProxmoxVnets } from "../src/network/adapters/proxmox-vnet";

const plan = buildInfrastructurePlan([{
    id: 1,
    owner_id: "student-1",
    profile_id: 1,
    profile_name: "Default",
    domains: [],
    state: "creating",
    vlan_tag: 2001,
    vnet_name: "lab2001",
    subnet_cidr: "10.200.1.0/24",
}]);

test("plans no VNet mutation when owned fields match", () => {
    const result = planProxmoxVnets(plan, {
        zones: [{ zone: "labzone", type: "simple" }],
        vnets: [{ vnet: "lab2001", zone: "labzone", tag: 2001 }],
    });

    assert.equal(result.checks.every(({ status }) => status === "pass"), true);
    assert.deepEqual(result.actions, []);
});

test("plans create and update without deleting unowned VNets", () => {
    const create = planProxmoxVnets(plan, {
        zones: [{ zone: "labzone", type: "simple" }],
        vnets: [{ vnet: "lab2099", zone: "labzone", tag: 2099 }],
    });
    const update = planProxmoxVnets(plan, {
        zones: [{ zone: "labzone", type: "simple" }],
        vnets: [{ vnet: "lab2001", zone: "wrong-zone", tag: 2002 }],
    });

    assert.deepEqual(create.actions.map(({ operation, resource }) => ({ operation, resource })), [
        { operation: "create", resource: "lab2001" },
    ]);
    assert.equal(create.checks.find(({ key }) => key.includes("unowned"))?.required, false);
    assert.deepEqual(update.actions.map(({ operation }) => operation), ["update"]);
});

test("fails the required zone check when the zone is absent", () => {
    const result = planProxmoxVnets(plan, {
        zones: [],
        vnets: [],
    });

    assert.deepEqual(result.checks[0], {
        key: "proxmox-sdn-zone",
        component: "proxmox-vnet",
        status: "fail",
        required: true,
        detail: "SDN zone labzone does not exist",
        observed: undefined,
    });
});