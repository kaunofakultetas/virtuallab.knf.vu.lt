// -----------------------------------------------------------
//  [*] Tests — network provisioning alongside the clone
//
//  createInstance runs the group's network steps while the
//  VM clones, and must never configure or start the VM on a
//  network that failed, nor return while network work is
//  still in flight. Proxmox, the pool and metadata are
//  stubbed with node:test mocks; nothing leaves the process.
//
//  Covers src/controllers/instances.controller.ts. Run with
//  `npm test` (the whole suite) inside the backend container.
// -----------------------------------------------------------

import assert from "node:assert/strict";
import test, { TestContext } from "node:test";

// The app-wide clients read these at import time.
process.env.PROXMOX_BASE_URL ??= "https://proxmox.invalid:8006";
process.env.PROXMOX_NODE_NAME ??= "pve";
process.env.PROXMOX_AUTH_TOKEN ??= "test";
process.env.GUACAMOLE_URL ??= "https://guacamole.invalid";

// A promise the test settles by hand.
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

async function harness(t: TestContext, cloneOutcome: Promise<boolean>) {
    const { Instances } = await import("../src/controllers/instances.controller");
    const { proxmox } = await import("../src/proxmox");
    const { pool } = await import("../src/utils/db");
    const { metadata } = await import("../src/utils/metadata");
    const calls: string[] = [];

    t.mock.method(metadata, "get", async () => undefined);
    t.mock.method(proxmox, "getVmConfig", async () => ({ scsi0: "local-lvm:base-9000-disk-0" }));
    t.mock.method(proxmox, "getNodeStorageStatus", async () => ({ active: 1, enabled: 1, avail: 1e12 }));
    t.mock.method(proxmox, "getNextAvailableId", async () => "10001");
    t.mock.method(proxmox, "cloneVM", async () => "UPID:clone");
    t.mock.method(proxmox, "waitForTaskCompletion", async (upid: string) => (
        upid === "UPID:clone" ? cloneOutcome : true
    ));
    for (const name of ["configVM", "startVM", "stopVM", "deleteVM"] as const) {
        t.mock.method(proxmox, name, async () => { calls.push(name); return `UPID:${name}`; });
    }
    t.mock.method(pool, "connect", async () => ({
        async query(sql: string) {
            if (sql.includes("count(*)")) return { rows: [{ count: "0" }] };
            if (sql.includes("INSERT INTO instances")) return { rows: [{ id: 42 }] };
            return { rows: [] };
        },
        release() {},
    }));
    t.mock.method(pool, "query", async (sql: string) => {
        if (sql.startsWith("DELETE FROM instances")) calls.push("delete-row");
        return { rows: [] };
    });

    const template = { id: 1, proxmox_id: "9000", name: "kali" };
    const create = (prepareNetwork: () => Promise<void>) => Instances.createInstance(
        "vu1234", template as never, 7, "lab2000", true, prepareNetwork,
    );
    return { calls, create };
}

test("a network failure during the clone destroys the clone and never attaches it", async (t) => {
    const clone = deferred<boolean>();
    const { calls, create } = await harness(t, clone.promise);
    let started = false;

    // Fails only once createInstance has started it, i.e. mid-clone.
    const created = create(() => {
        started = true;
        return new Promise((_, reject) => {
            setImmediate(() => reject(new Error("gateway apply failed")));
        });
    });
    // The rejection must not escape while it waits for the clone.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(started, "network work starts during the clone");
    clone.resolve(true);

    await assert.rejects(created, /gateway apply failed/);
    assert.ok(!calls.includes("configVM"), "net0 must never name an unready VNet");
    assert.ok(!calls.includes("startVM"));
    assert.ok(calls.includes("deleteVM"));
    assert.ok(calls.includes("delete-row"));
});

test("a failed clone still waits for the network work before reporting", async (t) => {
    const { create } = await harness(t, Promise.resolve(false));
    const network = deferred<void>();
    let settled = false;

    const created = create(() => network.promise).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false, "returned while the network steps were still running");

    network.resolve();
    await assert.rejects(created, /Failed to clone VM/);
});
