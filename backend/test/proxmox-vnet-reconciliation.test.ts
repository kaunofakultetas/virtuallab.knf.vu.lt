import assert from "node:assert/strict";
import test from "node:test";
import { buildInfrastructurePlan } from "../src/network/infrastructure-desired-state";
import {
    executeProxmoxVnetActions,
    planProxmoxVnets,
    ProxmoxVnetMutationClient,
} from "../src/network/adapters/proxmox-vnet";
import { ProxmoxNodeTaskStatus } from "../src/proxmox/types";

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

test("executes VNet mutations in order and applies SDN once", async () => {
    const calls: string[] = [];
    const transitions: string[] = [];
    const task = {
        status: "stopped",
        exitstatus: "OK",
        upid: "UPID:apply",
    } as ProxmoxNodeTaskStatus;
    const client: ProxmoxVnetMutationClient = {
        async createSdnVnet(input) { calls.push(`create:${input.vnet}`); },
        async updateSdnVnet(vnet, input) { calls.push(`update:${vnet}:${input.tag}`); },
        async applySdnConfiguration() {
            calls.push("apply");
            return task.upid;
        },
        async waitForTask(upid) {
            calls.push(`wait:${upid}`);
            return task;
        },
    };

    await executeProxmoxVnetActions(client, [
        {
            operation: "create",
            resource: "lab2001",
            desired: { vnet: "lab2001", zone: "labzone", tag: 2001 },
        },
        {
            operation: "update",
            resource: "lab2002",
            desired: { vnet: "lab2002", zone: "labzone", tag: 2002 },
        },
    ], async (action, executionState) => {
        transitions.push(`${action.resource}:${executionState}`);
    });

    assert.deepEqual(calls, [
        "create:lab2001",
        "update:lab2002:2002",
        "apply",
        "wait:UPID:apply",
    ]);
    assert.deepEqual(transitions, [
        "lab2001:applying",
        "lab2002:applying",
        "lab2001:succeeded",
        "lab2002:succeeded",
    ]);
});

test("marks a failed VNet mutation and stops the batch", async () => {
    const calls: string[] = [];
    const transitions: string[] = [];
    const client: ProxmoxVnetMutationClient = {
        async createSdnVnet(input) {
            calls.push(`create:${input.vnet}`);
            if (input.vnet === "lab2002") throw new Error("mutation failed");
        },
        async updateSdnVnet() { throw new Error("unexpected update"); },
        async applySdnConfiguration() { calls.push("apply"); return null; },
        async waitForTask() { throw new Error("unexpected task wait"); },
    };

    await assert.rejects(
        executeProxmoxVnetActions(client, [
            {
                operation: "create",
                resource: "lab2001",
                desired: { vnet: "lab2001", zone: "labzone", tag: 2001 },
            },
            {
                operation: "create",
                resource: "lab2002",
                desired: { vnet: "lab2002", zone: "labzone", tag: 2002 },
            },
        ], async (action, executionState) => {
            transitions.push(`${action.resource}:${executionState}`);
        }),
        /mutation failed/,
    );

    assert.deepEqual(calls, ["create:lab2001", "create:lab2002"]);
    assert.deepEqual(transitions, [
        "lab2001:applying",
        "lab2002:applying",
        "lab2001:failed",
        "lab2002:failed",
    ]);
});

test("does not apply SDN for an empty VNet action batch", async () => {
    let called = false;
    const client: ProxmoxVnetMutationClient = {
        async createSdnVnet() { called = true; },
        async updateSdnVnet() { called = true; },
        async applySdnConfiguration() { called = true; return null; },
        async waitForTask() { called = true; throw new Error("unexpected task wait"); },
    };

    await executeProxmoxVnetActions(client, []);

    assert.equal(called, false);
});

test("rejects a mismatched VNet action before mutation", async () => {
    let called = false;
    const client: ProxmoxVnetMutationClient = {
        async createSdnVnet() { called = true; },
        async updateSdnVnet() { called = true; },
        async applySdnConfiguration() { called = true; return null; },
        async waitForTask() { called = true; throw new Error("unexpected task wait"); },
    };

    await assert.rejects(
        executeProxmoxVnetActions(client, [{
            operation: "create",
            resource: "lab2002",
            desired: { vnet: "lab2001", zone: "labzone", tag: 2001 },
        }]),
        /does not match desired VNet/,
    );
    assert.equal(called, false);
});