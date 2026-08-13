import assert from "node:assert/strict";
import test from "node:test";
import {
    applyProxmoxVnetActions,
    InfrastructureApplyAttemptStore,
} from "../src/network/infrastructure-apply";
import {
    CheckpointReconciliationAttempt,
    FinishReconciliationAttempt,
    ReconciliationAttempt,
} from "../src/network/reconciliation-attempts";
import { ProxmoxNodeTaskStatus } from "../src/proxmox/types";

function attempt(overrides: Partial<ReconciliationAttempt> = {}): ReconciliationAttempt {
    return {
        id: "7",
        request_id: "00000000-0000-4000-8000-000000000007",
        requested_by: "admin",
        idempotency_key: null,
        mode: "apply",
        status: "running",
        desired_revision: "a".repeat(64),
        applied_revision: null,
        phase: "planned",
        checks: [],
        actions: [{
            component: "proxmox-vnet",
            operation: "create",
            execution_state: "planned",
            resource: "lab2001",
            desired: { vnet: "lab2001", zone: "labzone", tag: 2001 },
        }],
        error_code: null,
        error_detail: null,
        created_at: new Date(0),
        started_at: new Date(0),
        finished_at: null,
        ...overrides,
    };
}

function recordingStore() {
    const checkpoints: CheckpointReconciliationAttempt[] = [];
    const finishes: FinishReconciliationAttempt[] = [];
    const store: InfrastructureApplyAttemptStore = {
        async checkpoint(_id, input) {
            checkpoints.push(input);
            return attempt({ phase: input.phase, actions: input.actions ?? [] });
        },
        async finish(_id, input) {
            finishes.push(input);
            return attempt({
                status: input.status,
                phase: input.phase,
                actions: input.actions,
                applied_revision: input.appliedRevision ?? null,
                finished_at: new Date(1),
            });
        },
    };
    return { store, checkpoints, finishes };
}

test("persists VNet transitions and the applied revision", async () => {
    const recording = recordingStore();
    const calls: string[] = [];
    let created = false;

    const completed = await applyProxmoxVnetActions(attempt(), {
        attempts: recording.store,
        proxmox: {
            async createSdnVnet(input) { calls.push(`create:${input.vnet}`); created = true; },
            async updateSdnVnet() { throw new Error("unexpected update"); },
            async deleteSdnVnet() { throw new Error("unexpected delete"); },
            async applySdnConfiguration() { calls.push("apply"); return null; },
            async waitForTask() { throw new Error("unexpected wait"); },
            async getSdnVnets() {
                calls.push("observe");
                return created ? [{ vnet: "lab2001", zone: "labzone", tag: 2001 }] : [];
            },
        },
    });

    assert.deepEqual(calls, ["observe", "create:lab2001", "apply", "observe"]);
    assert.deepEqual(
        recording.checkpoints.map(({ actions }) => actions?.[0].execution_state),
        ["applying", "applying", "succeeded"],
    );
    assert.equal(recording.checkpoints[1].phase, "verifying");
    assert.equal(recording.checkpoints[1].checks?.[0].status, "pass");
    assert.equal(completed.phase, "applied");
    assert.equal(recording.finishes[0].appliedRevision, "a".repeat(64));
});

test("records a no-op compensation after a mutation fails before changing state", async () => {
    const recording = recordingStore();

    const completed = await applyProxmoxVnetActions(attempt(), {
        attempts: recording.store,
        proxmox: {
            async createSdnVnet() { throw new Error("mutation failed"); },
            async updateSdnVnet() { throw new Error("unexpected update"); },
            async deleteSdnVnet() { throw new Error("unexpected delete"); },
            async applySdnConfiguration() { throw new Error("unexpected apply"); },
            async waitForTask() { throw new Error("unexpected wait"); },
            async getSdnVnets() { return []; },
        },
    });

    assert.ok(recording.checkpoints.some(
        ({ actions }) => actions?.[0].execution_state === "failed",
    ));
    assert.equal(completed.phase, "compensated");
    assert.equal(recording.finishes[0].actions[0].execution_state, "compensated");
    assert.equal(recording.finishes[0].appliedRevision, undefined);
});

test("rejects unsupported actions before mutating Proxmox", async () => {
    const recording = recordingStore();
    let mutated = false;
    const unsupported = attempt({
        actions: [{
            component: "access",
            operation: "update",
            execution_state: "planned",
            resource: "access-trunk",
            desired: {},
        }],
    });

    await assert.rejects(
        applyProxmoxVnetActions(unsupported, {
            attempts: recording.store,
            proxmox: {
                async createSdnVnet() { mutated = true; },
                async updateSdnVnet() { mutated = true; },
                async deleteSdnVnet() { mutated = true; },
                async applySdnConfiguration() { mutated = true; return null; },
                async waitForTask() { mutated = true; throw new Error("unexpected wait"); },
                async getSdnVnets() { mutated = true; return []; },
            },
        }),
        /does not support access actions/,
    );

    assert.equal(mutated, false);
    assert.deepEqual(recording.checkpoints, []);
    assert.deepEqual(recording.finishes, []);
});

test("fails after bounded VNet convergence attempts", async () => {
    const recording = recordingStore();
    let observations = 0;
    const sleeps: number[] = [];

    const completed = await applyProxmoxVnetActions(attempt(), {
        attempts: recording.store,
        proxmox: {
            async createSdnVnet() {},
            async updateSdnVnet() { throw new Error("unexpected update"); },
            async deleteSdnVnet() { throw new Error("unsafe delete"); },
            async applySdnConfiguration() { return null; },
            async waitForTask() { throw new Error("unexpected wait"); },
            async getSdnVnets() {
                observations += 1;
                if (observations === 1) return [];
                return [{ vnet: "lab2001", zone: "labzone", tag: 2099 }];
            },
        },
        convergence: {
            attempts: 3,
            intervalMs: 25,
            async sleep(milliseconds) { sleeps.push(milliseconds); },
        },
    });

    assert.equal(observations, 5);
    assert.deepEqual(sleeps, [25, 25]);
    assert.equal(completed.phase, "compensation-failed");
    assert.equal(recording.finishes[0].errorCode, "ProxmoxVnetConvergenceError");
    assert.equal(recording.finishes[0].actions[0].execution_state, "failed");
    assert.equal(recording.finishes[0].checks[0].status, "fail");
    assert.equal(recording.finishes[0].appliedRevision, undefined);
});

test("records an opaque failure when convergence observation fails", async () => {
    const recording = recordingStore();
    let observations = 0;
    let created = false;

    const completed = await applyProxmoxVnetActions(attempt(), {
        attempts: recording.store,
        proxmox: {
            async createSdnVnet() { created = true; },
            async updateSdnVnet() { throw new Error("unexpected update"); },
            async deleteSdnVnet() { created = false; },
            async applySdnConfiguration() { return null; },
            async waitForTask() { throw new Error("unexpected wait"); },
            async getSdnVnets() {
                observations += 1;
                if (observations === 2) throw new Error("Authorization: private-token");
                return created ? [{ vnet: "lab2001", zone: "labzone", tag: 2001 }] : [];
            },
        },
        convergence: { attempts: 1 },
    });

    assert.equal(completed.phase, "compensated");
    assert.equal(recording.finishes[0].errorCode, "ProxmoxVnetObservationError");
    assert.equal(
        recording.finishes[0].errorDetail,
        "Proxmox VNet apply failed; compensation succeeded",
    );
    assert.doesNotMatch(recording.finishes[0].errorDetail ?? "", /private-token/);
    assert.equal(recording.finishes[0].actions[0].execution_state, "compensated");
});

test("deletes only a VNet created by the failed attempt", async () => {
    const recording = recordingStore();
    const calls: string[] = [];
    let created = false;

    const completed = await applyProxmoxVnetActions(attempt(), {
        attempts: recording.store,
        proxmox: {
            async createSdnVnet() { created = true; calls.push("create"); },
            async updateSdnVnet() { throw new Error("unexpected update"); },
            async deleteSdnVnet(vnet) { created = false; calls.push(`delete:${vnet}`); },
            async applySdnConfiguration() { calls.push("apply"); return "UPID:apply"; },
            async waitForTask() {
                calls.push("wait");
                if (calls.filter((call) => call === "wait").length === 1) {
                    throw new Error("apply task failed");
                }
                return {
                    status: "stopped",
                    exitstatus: "OK",
                    upid: "UPID:apply",
                } as ProxmoxNodeTaskStatus;
            },
            async getSdnVnets() {
                calls.push("observe");
                return created ? [{ vnet: "lab2001", zone: "labzone", tag: 2001 }] : [];
            },
        },
        convergence: { attempts: 1 },
    });

    assert.equal(completed.phase, "compensated");
    assert.deepEqual(calls, [
        "observe",
        "create",
        "apply",
        "wait",
        "observe",
        "delete:lab2001",
        "apply",
        "wait",
        "observe",
    ]);
    assert.equal(recording.finishes[0].actions[0].execution_state, "compensated");
});

test("compensates the first create when a later create fails", async () => {
    const recording = recordingStore();
    const existing = new Map<string, { vnet: string; zone: string; tag: number }>();
    const deleted: string[] = [];
    const partialAttempt = attempt({
        actions: [
            {
                component: "proxmox-vnet",
                operation: "create",
                execution_state: "planned",
                resource: "lab2001",
                desired: { vnet: "lab2001", zone: "labzone", tag: 2001 },
            },
            {
                component: "proxmox-vnet",
                operation: "create",
                execution_state: "planned",
                resource: "lab2002",
                desired: { vnet: "lab2002", zone: "labzone", tag: 2002 },
            },
        ],
    });

    const completed = await applyProxmoxVnetActions(partialAttempt, {
        attempts: recording.store,
        proxmox: {
            async createSdnVnet(input) {
                if (input.vnet === "lab2002") throw new Error("second create failed");
                existing.set(input.vnet, {
                    vnet: input.vnet,
                    zone: input.zone,
                    tag: input.tag ?? 0,
                });
            },
            async updateSdnVnet() { throw new Error("unexpected update"); },
            async deleteSdnVnet(vnet) { deleted.push(vnet); existing.delete(vnet); },
            async applySdnConfiguration() { return null; },
            async waitForTask() { throw new Error("unexpected wait"); },
            async getSdnVnets() { return [...existing.values()]; },
        },
        convergence: { attempts: 1 },
    });

    assert.equal(completed.phase, "compensated");
    assert.deepEqual(deleted, ["lab2001"]);
    assert.deepEqual(recording.finishes[0].actions.map(({ execution_state }) => execution_state), [
        "compensated",
        "compensated",
    ]);
});

test("preserves the apply error when compensation apply fails", async () => {
    const recording = recordingStore();
    let created = false;
    let applyCalls = 0;

    const completed = await applyProxmoxVnetActions(attempt(), {
        attempts: recording.store,
        proxmox: {
            async createSdnVnet() { created = true; },
            async updateSdnVnet() { throw new Error("unexpected update"); },
            async deleteSdnVnet() { created = false; },
            async applySdnConfiguration() {
                applyCalls += 1;
                throw new Error(applyCalls === 1 ? "original apply failure" : "rollback apply failure");
            },
            async waitForTask() { throw new Error("unexpected wait"); },
            async getSdnVnets() {
                return created ? [{ vnet: "lab2001", zone: "labzone", tag: 2001 }] : [];
            },
        },
        convergence: { attempts: 1 },
    });

    assert.equal(completed.phase, "compensation-failed");
    assert.equal(recording.finishes[0].errorCode, "Error");
    assert.equal(
        recording.finishes[0].errorDetail,
        "Proxmox VNet apply failed; compensation also failed",
    );
    assert.equal(recording.finishes[0].actions[0].execution_state, "failed");
    assert.equal(recording.finishes[0].checks[0].key, "proxmox-vnet-compensation");
    assert.equal(recording.finishes[0].checks[0].status, "fail");
});

test("restores a pre-existing VNet after an update failure", async () => {
    const recording = recordingStore();
    const original = { vnet: "lab2001", zone: "old-zone", tag: 2000 };
    let current = original;
    let applyCalls = 0;
    const updateAttempt = attempt({
        actions: [{
            component: "proxmox-vnet",
            operation: "update",
            execution_state: "planned",
            resource: "lab2001",
            desired: { vnet: "lab2001", zone: "labzone", tag: 2001 },
        }],
    });

    const completed = await applyProxmoxVnetActions(updateAttempt, {
        attempts: recording.store,
        proxmox: {
            async createSdnVnet() { throw new Error("unexpected create"); },
            async updateSdnVnet(vnet, desired) {
                current = { vnet, zone: desired.zone ?? current.zone, tag: desired.tag ?? current.tag };
            },
            async deleteSdnVnet() { throw new Error("unexpected delete"); },
            async applySdnConfiguration() {
                applyCalls += 1;
                if (applyCalls === 1) throw new Error("apply failed");
                return null;
            },
            async waitForTask() { throw new Error("unexpected wait"); },
            async getSdnVnets() { return [current]; },
        },
        convergence: { attempts: 1 },
    });

    assert.equal(completed.phase, "compensated");
    assert.deepEqual(current, original);
    assert.equal(applyCalls, 2);
});

test("rejects create actions for pre-existing VNets before mutation", async () => {
    const recording = recordingStore();
    let mutated = false;

    const completed = await applyProxmoxVnetActions(attempt(), {
        attempts: recording.store,
        proxmox: {
            async createSdnVnet() { mutated = true; },
            async updateSdnVnet() { mutated = true; },
            async deleteSdnVnet() { mutated = true; },
            async applySdnConfiguration() { mutated = true; return null; },
            async waitForTask() { mutated = true; throw new Error("unexpected wait"); },
            async getSdnVnets() {
                return [{ vnet: "lab2001", zone: "unowned-zone", tag: 2099 }];
            },
        },
    });

    assert.equal(mutated, false);
    assert.equal(completed.phase, "apply-failed");
    assert.equal(recording.finishes[0].errorCode, "ProxmoxVnetSnapshotError");
});