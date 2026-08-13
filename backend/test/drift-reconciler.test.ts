import assert from "node:assert/strict";
import test from "node:test";
import {
    DriftReconcilerDependencies,
    reconcileNetworkDrift,
} from "../src/network/drift-reconciler";
import {
    ReconciliationAttempt,
    ReconciliationLockedError,
} from "../src/network/reconciliation-attempts";

function attempt(overrides: Partial<ReconciliationAttempt> = {}): ReconciliationAttempt {
    return {
        id: "1",
        request_id: "00000000-0000-4000-8000-000000000000",
        requested_by: "system-drift-reconciler",
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

function harness(overrides: Partial<DriftReconcilerDependencies> = {}) {
    const repaired: string[] = [];
    const dependencies: DriftReconcilerDependencies = {
        getMode: async () => "active",
        observeGateway: async () => ({ drifted: false, detail: "converged" }),
        observeAccess: async () => ({
            policyDrifted: false,
            trunkDrifted: false,
            detail: "converged",
        }),
        observeVmFirewalls: async () => ({ drifted: [], detail: "converged" }),
        repairVmFirewalls: async (vmids) => {
            repaired.push(...vmids.map((vmid) => `vm-firewall:${vmid}`));
            return { repaired: vmids, failed: [] };
        },
        repair: {
            "gateway-policy": async () => { repaired.push("gateway-policy"); return attempt(); },
            "access-policy": async () => { repaired.push("access-policy"); return attempt(); },
            "access-trunk": async () => { repaired.push("access-trunk"); return attempt(); },
        },
        ...overrides,
    };
    return { repaired, dependencies };
}

test("a converged stack is only read from, never written to", async () => {
    // An unconditional apply restarts Squid and dnsmasq and arms a rollback
    // timer, so a timer-driven pass would interrupt every session on a schedule
    // in order to write files that were already correct.
    const { repaired, dependencies } = harness();
    const report = await reconcileNetworkDrift("system-drift-reconciler", dependencies);

    assert.equal(report.ran, true);
    assert.deepEqual(report.drifted, []);
    assert.deepEqual(repaired, []);
});

test("only the drifted component is repaired", async () => {
    const { repaired, dependencies } = harness({
        observeGateway: async () => ({ drifted: true, detail: "gateway-vlan-interfaces" }),
    });
    const report = await reconcileNetworkDrift("system-drift-reconciler", dependencies);

    assert.deepEqual(report.drifted, ["gateway-policy"]);
    assert.deepEqual(repaired, ["gateway-policy"]);
});

test("repairs run trunk first, matching provisioning order", async () => {
    // An Access VLAN interface on a trunk that does not carry its VLAN passes no
    // frames, so repairing the policy first would converge onto something that
    // still does not work.
    const { repaired, dependencies } = harness({
        observeGateway: async () => ({ drifted: true, detail: "drift" }),
        observeAccess: async () => ({ policyDrifted: true, trunkDrifted: true, detail: "drift" }),
    });
    await reconcileNetworkDrift("system-drift-reconciler", dependencies);

    assert.deepEqual(repaired, ["access-trunk", "access-policy", "gateway-policy"]);
});


test("a VM firewall that drifted is repaired, after everything it depends on", async () => {
    // Peer lists are rendered into per-VM rules, and an admin can change them
    // long after provisioning. Nothing else re-applies them, so a new peering
    // would open the Gateway's forward path while every target VM went on
    // dropping the traffic.
    const { repaired, dependencies } = harness({
        observeGateway: async () => ({ drifted: true, detail: "drift" }),
        observeVmFirewalls: async () => ({ drifted: ["10000"], detail: "drift" }),
    });
    const report = await reconcileNetworkDrift("system-drift-reconciler", dependencies);

    assert.deepEqual(report.drifted, ["gateway-policy", "vm-firewall"]);
    assert.deepEqual(repaired, ["gateway-policy", "vm-firewall:10000"]);
});

test("one unreachable guest does not stop the other VM firewalls", async () => {
    const { dependencies } = harness({
        observeVmFirewalls: async () => ({ drifted: ["10000", "10001"], detail: "drift" }),
        repairVmFirewalls: async () => ({ repaired: ["10000"], failed: ["10001"] }),
    });
    const report = await reconcileNetworkDrift("system-drift-reconciler", dependencies);

    assert.deepEqual(report.repaired, ["vm-firewall"]);
    assert.equal(report.failed.length, 1);
    assert.match(report.failed[0].detail, /10001/);
});

test("nothing runs outside active mode", async () => {
    const { repaired, dependencies } = harness({
        getMode: async () => "legacy",
        observeGateway: async () => { throw new Error("must not observe"); },
    });
    const report = await reconcileNetworkDrift("system-drift-reconciler", dependencies);

    assert.equal(report.ran, false);
    assert.match(report.reason ?? "", /legacy/);
    assert.deepEqual(repaired, []);
});

test("a held reconciliation lock ends the pass without treating it as failure", async () => {
    // Whatever holds the lock is converging the same desired state anyway.
    const { dependencies } = harness({
        observeAccess: async () => ({ policyDrifted: true, trunkDrifted: false, detail: "drift" }),
        repair: { "access-policy": async () => { throw new ReconciliationLockedError(); } },
    });
    const report = await reconcileNetworkDrift("system-drift-reconciler", dependencies);

    assert.equal(report.ran, false);
    assert.match(report.reason ?? "", /already running/);
    assert.deepEqual(report.failed, []);
});

test("a failed repair is reported without stopping the other components", async () => {
    const { repaired, dependencies } = harness({
        observeGateway: async () => ({ drifted: true, detail: "drift" }),
        observeAccess: async () => ({ policyDrifted: true, trunkDrifted: false, detail: "drift" }),
        repair: {
            "access-policy": async () => { throw new Error("guest unreachable"); },
            "gateway-policy": async () => { repaired.push("gateway-policy"); return attempt(); },
        },
    });
    const report = await reconcileNetworkDrift("system-drift-reconciler", dependencies);

    assert.deepEqual(report.repaired, ["gateway-policy"]);
    assert.equal(report.failed.length, 1);
    assert.match(report.failed[0].detail, /guest unreachable/);
});

test("an attempt that finishes failed counts as failed, not repaired", async () => {
    const { dependencies } = harness({
        observeGateway: async () => ({ drifted: true, detail: "drift" }),
        repair: {
            "gateway-policy": async () => attempt({
                status: "failed",
                error_code: "gateway-apply-verify",
            }),
        },
    });
    const report = await reconcileNetworkDrift("system-drift-reconciler", dependencies);

    assert.deepEqual(report.repaired, []);
    assert.match(report.failed[0].detail, /gateway-apply-verify/);
});
