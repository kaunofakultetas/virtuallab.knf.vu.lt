// -----------------------------------------------------------
//  [*] Tests — the group release sequence
//
//  Guards, ordering (VNet first, trunk last), paced retries
//  around locks and revisions, and the recorded failure
//  reasons.
//
//  Covers src/network/teardown.ts. Run with `npm test` (the
//  whole suite) inside the backend container.
// -----------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import { NetworkGroup } from "../src/types/network-groups";
import { AccessApplyRevisionError } from "../src/network/access-apply-runner";
import { GatewayApplyRevisionError } from "../src/network/gateway-apply-runner";
import {
    findVnetReferencesInProxmox,
    NetworkTeardownDependencies,
    NetworkTeardownError,
    releaseNetworkGroup,
} from "../src/network/teardown";
import {
    ReconciliationAttempt,
    ReconciliationLockedError,
} from "../src/network/reconciliation-attempts";

function group(overrides: Partial<NetworkGroup> = {}): NetworkGroup {
    return {
        id: 3,
        owner_id: "vu1234",
        profile_id: 1,
        state: "active",
        vlan_tag: 2000,
        vnet_name: "lab2000",
        subnet_cidr: "10.200.0.0/24",
        desired_revision: "a".repeat(64),
        applied_revision: "a".repeat(64),
        last_error: null,
        created_at: new Date(0),
        updated_at: new Date(0),
        ...overrides,
    } as NetworkGroup;
}

function attempt(id: string, overrides: Partial<ReconciliationAttempt> = {}): ReconciliationAttempt {
    return {
        id,
        request_id: "00000000-0000-4000-8000-000000000000",
        requested_by: "vu1234",
        idempotency_key: null,
        mode: "apply",
        status: "succeeded",
        desired_revision: "a".repeat(64),
        applied_revision: "a".repeat(64),
        phase: "applied",
        checks: [],
        actions: [],
        error_code: null,
        error_detail: null,
        created_at: new Date(0),
        started_at: new Date(0),
        finished_at: new Date(0),
        ...overrides,
    };
}

function harness(overrides: Partial<NetworkTeardownDependencies> = {}) {
    const order: string[] = [];
    const slept: number[] = [];
    const recorded: string[] = [];
    const dependencies: NetworkTeardownDependencies = {
        getMode: async () => "active",
        // Recorded rather than performed: the retry backoff is real time in
        // production and would be real time here too.
        async sleep(milliseconds) { slept.push(milliseconds); },
        async recordTeardownError(_groupId, lastError) { recorded.push(lastError); },
        async markDeleting(groupId) {
            order.push("mark-deleting");
            return group({ id: groupId, state: "deleting" });
        },
        async findVnetReferences() { order.push("find-references"); return []; },
        async deleteVnet() { order.push("delete-vnet"); },
        async reconcileGatewayPolicy() { order.push("gateway-policy"); return attempt("1"); },
        async reconcileAccessPolicy() { order.push("access-policy"); return attempt("2"); },
        async reconcileAccessTrunk() { order.push("access-trunk"); return attempt("3"); },
        async deleteRecord() { order.push("delete-record"); return true; },
        infrastructureRevision: async () => "a".repeat(64),
        gatewayRevision: async () => "b".repeat(64),
        ...overrides,
    };
    return { order, slept, recorded, dependencies };
}

test("teardown runs the exact inverse of provisioning", async () => {
    // Each appliance loses its VLAN interface before the trunk stops carrying
    // the VLAN, so no interface is left attached to a trunk that cannot reach it.
    const { order, dependencies } = harness();
    const outcome = await releaseNetworkGroup(group(), "vu1234", dependencies);

    assert.deepEqual(order, [
        "mark-deleting",
        "find-references",
        "delete-vnet",
        "gateway-policy",
        "access-policy",
        "access-trunk",
        "delete-record",
    ]);
    assert.equal(outcome.released, true);
    assert.deepEqual(
        outcome.released ? { vlan: outcome.vlan_tag, vnet: outcome.vnet_name } : null,
        { vlan: 2000, vnet: "lab2000" },
    );
});

test("the group leaves the plan before the VNet is deleted", async () => {
    // Marking `deleting` is what makes the prune steps converge, and it stops a
    // concurrent VNet apply recreating what is about to be removed.
    const { order, dependencies } = harness();
    await releaseNetworkGroup(group(), "vu1234", dependencies);

    assert.ok(order.indexOf("mark-deleting") < order.indexOf("delete-vnet"));
});

test("a group that still has instances is refused, not torn down", async () => {
    // A group is never released because one of several attached VMs was removed.
    const { order, dependencies } = harness({ markDeleting: async () => null });
    const outcome = await releaseNetworkGroup(group(), "vu1234", dependencies);

    assert.equal(outcome.released, false);
    assert.deepEqual(order, []);
});

test("a VNet still referenced by a guest stops teardown before anything is dismantled", async () => {
    // Read from Proxmox, not the database: a VM created outside the orchestrator
    // would be invisible to any query over `instances`.
    const { order, dependencies } = harness({
        findVnetReferences: async () => ["qemu/10001"],
    });

    await assert.rejects(
        () => releaseNetworkGroup(group(), "vu1234", dependencies),
        (error: NetworkTeardownError) => (
            error.step === "guard" && /qemu\/10001/.test(error.message)
        ),
    );
    assert.ok(!order.includes("delete-vnet"));
    assert.ok(!order.includes("gateway-policy"));
});

test("a failed VNet delete leaves the appliances untouched", async () => {
    // Failing here must not leave a group whose Gateway and Access
    // configuration has already been torn down.
    const { order, dependencies } = harness({
        deleteVnet: async () => { throw new Error("SDN apply timed out"); },
    });

    await assert.rejects(
        () => releaseNetworkGroup(group(), "vu1234", dependencies),
        (error: NetworkTeardownError) => error.step === "vnet",
    );
    assert.deepEqual(order, ["mark-deleting", "find-references"]);
});

test("the row is never released while a reconciliation is outstanding", async () => {
    const { order, dependencies } = harness({
        async reconcileAccessTrunk() { throw new Error("host unreachable"); },
    });

    await assert.rejects(
        () => releaseNetworkGroup(group(), "vu1234", dependencies),
        (error: NetworkTeardownError) => error.step === "access-trunk",
    );
    assert.ok(!order.includes("delete-record"));
});

test("a revision conflict is retried against a freshly read revision", async () => {
    let calls = 0;
    const { dependencies } = harness({
        async reconcileGatewayPolicy() {
            calls += 1;
            if (calls === 1) throw new GatewayApplyRevisionError("x".repeat(64), "y".repeat(64));
            return attempt("1");
        },
    });

    assert.equal((await releaseNetworkGroup(group(), "vu1234", dependencies)).released, true);
    assert.equal(calls, 2);
});

test("a revision that never settles fails the named step", async () => {
    const { dependencies } = harness({
        async reconcileAccessPolicy() {
            throw new AccessApplyRevisionError("x".repeat(64), "y".repeat(64));
        },
        revisionAttempts: 2,
    });

    await assert.rejects(
        () => releaseNetworkGroup(group(), "vu1234", dependencies),
        (error: NetworkTeardownError) => (
            error.step === "access-policy" && /after 2 attempts/.test(error.message)
        ),
    );
});

test("a stranded teardown records why it stopped, on the row it stranded", async () => {
    // The group stays `deleting` with its allocation reserved either way. What
    // changes is that the operator can now see the reason on the row instead of
    // finding `last_error = NULL` and having to go to the logs.
    const { recorded, dependencies } = harness({
        async reconcileAccessPolicy() {
            throw new Error("Access apply is blocked by required checks: access-live-trunks");
        },
    });

    await assert.rejects(() => releaseNetworkGroup(group(), "vu1234", dependencies));
    assert.equal(recorded.length, 1);
    assert.match(recorded[0], /access-live-trunks/);
});

test("a teardown that succeeds records no error", async () => {
    const { recorded, dependencies } = harness();

    assert.equal((await releaseNetworkGroup(group(), "vu1234", dependencies)).released, true);
    assert.deepEqual(recorded, []);
});

test("a held reconciliation lock is waited out, not spun through", async () => {
    // Regression: the loop used a bare `continue`, so all three attempts were
    // spent inside a millisecond. Both things it retries are cleared by another
    // operation finishing -- appliance time, not CPU time -- so retrying with no
    // delay made three attempts worth exactly one, and teardown failed whenever
    // the ten-minute drift sweep happened to be mid-repair.
    let calls = 0;
    const { slept, dependencies } = harness({
        async reconcileGatewayPolicy() {
            calls += 1;
            throw new ReconciliationLockedError();
        },
        revisionAttempts: 3,
        revisionRetryMs: 3_000,
    });

    await assert.rejects(
        () => releaseNetworkGroup(group(), "vu1234", dependencies),
        (error: NetworkTeardownError) => (
            error.step === "gateway-policy"
            && /already running/.test(error.message)
        ),
    );
    assert.equal(calls, 3);
    // Two waits for three attempts: nothing is gained by sleeping before failing.
    assert.deepEqual(slept, [3_000, 3_000]);
});

test("a lock that clears between attempts lets teardown finish", async () => {
    let calls = 0;
    const { slept, dependencies } = harness({
        async reconcileGatewayPolicy() {
            calls += 1;
            if (calls === 1) throw new ReconciliationLockedError();
            return attempt("1");
        },
        revisionRetryMs: 3_000,
    });

    assert.equal((await releaseNetworkGroup(group(), "vu1234", dependencies)).released, true);
    assert.deepEqual(slept, [3_000]);
});

test("an attempt that finishes failed is a teardown failure", async () => {
    const { dependencies } = harness({
        async reconcileGatewayPolicy() {
            return attempt("1", { status: "failed", error_code: "gateway-apply-verify" });
        },
    });

    await assert.rejects(
        () => releaseNetworkGroup(group(), "vu1234", dependencies),
        (error: NetworkTeardownError) => /gateway-apply-verify/.test(error.message),
    );
});

test("a row that gains an instance during teardown is not released", async () => {
    // Refusing keeps the VLAN out of the pool, which is the safe direction.
    const { dependencies } = harness({ deleteRecord: async () => false });

    await assert.rejects(
        () => releaseNetworkGroup(group(), "vu1234", dependencies),
        (error: NetworkTeardownError) => error.step === "release",
    );
});

test("nothing is torn down outside active mode", async () => {
    const { order, dependencies } = harness({ getMode: async () => "legacy" });
    const outcome = await releaseNetworkGroup(group(), "vu1234", dependencies);

    assert.equal(outcome.released, false);
    assert.deepEqual(order, []);
});

test("an unallocated group needs no teardown", async () => {
    const { order, dependencies } = harness();
    const outcome = await releaseNetworkGroup(
        group({ vlan_tag: null, vnet_name: null, subnet_cidr: null, state: "planned" }),
        "vu1234",
        dependencies,
    );

    assert.equal(outcome.released, false);
    assert.deepEqual(order, []);
});

// A fake cluster: guests keyed "node/type/vmid", each with the config the API returns.
function cluster(configs: Record<string, Record<string, unknown>>) {
    return {
        async getClusterResources() {
            return Object.keys(configs).map((key) => {
                const [node, type, vmid] = key.split("/");
                return { node, type, vmid: Number(vmid) };
            });
        },
        async getGuestConfig(node: string, type: "qemu" | "lxc", vmid: string) {
            return configs[`${node}/${type}/${vmid}`];
        },
    } as unknown as Parameters<typeof findVnetReferencesInProxmox>[0];
}

test("the VNet guard finds containers and guests on other nodes, not just local VMs", async () => {
    const references = await findVnetReferencesInProxmox(cluster({
        "pve/qemu/10001": { net0: "virtio=AA:BB:CC:00:00:01,bridge=lab2000,firewall=1" },
        "pve/lxc/300": { net0: "name=eth0,bridge=lab2000,ip=dhcp" },
        "pve2/qemu/10002": { net0: "virtio=AA:BB:CC:00:00:02,bridge=lab2000" },
        "pve/qemu/10003": { net0: "virtio=AA:BB:CC:00:00:03,bridge=vmbr0" },
    }), "lab2000");

    assert.deepEqual(references.sort(), ["lxc/300", "qemu/10001", "qemu/10002"]);
});

test("the VNet guard never mistakes lab20001 for lab2000", async () => {
    const references = await findVnetReferencesInProxmox(cluster({
        "pve/qemu/10001": { net0: "virtio=AA:BB:CC:00:00:01,bridge=lab20001" },
    }), "lab2000");

    assert.deepEqual(references, []);
});

test("the VNet guard fails closed when a listed guest cannot be read", async () => {
    const client = cluster({ "pve/qemu/10001": {} });
    client.getGuestConfig = async () => { throw new Error("403 Permission check failed"); };

    await assert.rejects(findVnetReferencesInProxmox(client, "lab2000"), /403/);
});

test("the VNet guard skips a guest destroyed while it was scanning", async () => {
    const client = cluster({ "pve/qemu/10001": {} });
    let listings = 0;
    client.getClusterResources = async () => (
        listings++ === 0 ? [{ node: "pve", type: "qemu", vmid: 10001 }] : []
    );
    client.getGuestConfig = async () => { throw new Error("500 Configuration file does not exist"); };

    assert.deepEqual(await findVnetReferencesInProxmox(client, "lab2000"), []);
});
