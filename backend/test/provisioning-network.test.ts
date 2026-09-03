// -----------------------------------------------------------
//  [*] Tests — the four-step provisioning orchestration
//
//  VNet, trunk, Access policy, Gateway policy — in order,
//  with bounded revision retries and no unwinding on
//  failure.
//
//  Covers src/network/provisioning-network.ts. Run with `npm
//  test` (the whole suite) inside the backend container.
// -----------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import { NetworkGroup } from "../src/types/network-groups";
import { AccessApplyRevisionError } from "../src/network/access-apply-runner";
import { AccessTrunkRevisionError } from "../src/network/access-trunk-runner";
import { GatewayApplyRevisionError } from "../src/network/gateway-apply-runner";
import {
    ensureNetworkGroupInfrastructure,
    NetworkProvisioningDependencies,
    NetworkProvisioningError,
} from "../src/network/provisioning-network";
import { ReconciliationAttempt } from "../src/network/reconciliation-attempts";

const INFRASTRUCTURE_REVISION = "a".repeat(64);
const GATEWAY_REVISION = "b".repeat(64);

function group(overrides: Partial<NetworkGroup> = {}): NetworkGroup {
    return {
        id: 7,
        owner_id: "vu1234",
        profile_id: 1,
        state: "creating",
        vlan_tag: 2002,
        vnet_name: "lab2002",
        subnet_cidr: "10.200.2.0/24",
        desired_revision: INFRASTRUCTURE_REVISION,
        applied_revision: null,
        last_error: null,
        created_at: new Date(0),
        updated_at: new Date(0),
        ...overrides,
    } as NetworkGroup;
}

function attempt(
    id: string,
    overrides: Partial<ReconciliationAttempt> = {},
): ReconciliationAttempt {
    return {
        id,
        request_id: `00000000-0000-4000-8000-00000000000${id}`,
        requested_by: "vu1234",
        idempotency_key: null,
        mode: "apply",
        status: "succeeded",
        desired_revision: INFRASTRUCTURE_REVISION,
        applied_revision: INFRASTRUCTURE_REVISION,
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

function harness(overrides: Partial<NetworkProvisioningDependencies> = {}) {
    const order: string[] = [];
    const dependencies: NetworkProvisioningDependencies = {
        async ensureVnet() { order.push("vnet"); return attempt("1"); },
        async applyAccessTrunk() { order.push("access-trunk"); return attempt("2"); },
        async applyAccessPolicy() { order.push("access-policy"); return attempt("3"); },
        async applyGatewayPolicy() {
            order.push("gateway-policy");
            return attempt("4", {
                desired_revision: GATEWAY_REVISION,
                applied_revision: GATEWAY_REVISION,
            });
        },
        infrastructureRevision: async () => INFRASTRUCTURE_REVISION,
        gatewayRevision: async () => GATEWAY_REVISION,
        ...overrides,
    };
    return { order, dependencies };
}

test("every executor runs, in the only order that leaves no broken intermediate", async () => {
    // The trunk must precede the Access policy: the policy creates a VLAN
    // subinterface on that trunk, and without membership the interface would
    // exist while passing no frames.
    const { order, dependencies } = harness();
    const result = await ensureNetworkGroupInfrastructure(group(), "vu1234", dependencies);
    assert.deepEqual(order, ["vnet", "access-trunk", "access-policy", "gateway-policy"]);
    assert.deepEqual(result.steps.map(({ name }) => name), [
        "vnet",
        "access-trunk",
        "access-policy",
        "gateway-policy",
    ]);
});

test("the Gateway step is given its own revision, not the infrastructure one", async () => {
    // Gateway desired state is a separate document with its own hash. Passing
    // the infrastructure revision would fail every apply on a healthy stack.
    const seen: string[] = [];
    const { dependencies } = harness({
        async applyGatewayPolicy(input) {
            seen.push(input.expectedRevision);
            return attempt("4", { applied_revision: GATEWAY_REVISION });
        },
    });
    await ensureNetworkGroupInfrastructure(group(), "vu1234", dependencies);
    assert.deepEqual(seen, [GATEWAY_REVISION]);
});

test("the requesting user is carried through to every attempt", async () => {
    const requesters: string[] = [];
    const record = (input: { requestedBy: string }) => {
        requesters.push(input.requestedBy);
        return Promise.resolve(attempt("9"));
    };
    const { dependencies } = harness({
        applyAccessTrunk: record,
        applyAccessPolicy: record,
        applyGatewayPolicy: record,
    });
    await ensureNetworkGroupInfrastructure(group(), "vu5678", dependencies);
    assert.deepEqual(requesters, ["vu5678", "vu5678", "vu5678"]);
});

test("a revision conflict is retried against a freshly read revision", async () => {
    // Two students provisioning at once is routine; it must not turn into a
    // failed request for a race that has already resolved itself.
    let calls = 0;
    const revisions = [INFRASTRUCTURE_REVISION, "c".repeat(64)];
    const { dependencies } = harness({
        infrastructureRevision: async () => revisions[Math.min(calls, revisions.length - 1)],
        async applyAccessTrunk() {
            calls += 1;
            if (calls === 1) throw new AccessTrunkRevisionError("x".repeat(64), "y".repeat(64));
            return attempt("2");
        },
    });
    const result = await ensureNetworkGroupInfrastructure(group(), "vu1234", dependencies);
    assert.equal(calls, 2);
    assert.equal(result.steps[1].name, "access-trunk");
});

test("a revision that never settles fails the named step rather than looping", async () => {
    const { dependencies } = harness({
        async applyAccessPolicy() {
            throw new AccessApplyRevisionError("x".repeat(64), "y".repeat(64));
        },
        revisionAttempts: 2,
    });
    await assert.rejects(
        () => ensureNetworkGroupInfrastructure(group(), "vu1234", dependencies),
        (error: NetworkProvisioningError) => (
            error.step === "access-policy" && /after 2 attempts/.test(error.message)
        ),
    );
});

test("a Gateway revision conflict is retried too", async () => {
    let calls = 0;
    const { dependencies } = harness({
        async applyGatewayPolicy() {
            calls += 1;
            if (calls === 1) throw new GatewayApplyRevisionError("x".repeat(64), "y".repeat(64));
            return attempt("4", { applied_revision: GATEWAY_REVISION });
        },
    });
    await ensureNetworkGroupInfrastructure(group(), "vu1234", dependencies);
    assert.equal(calls, 2);
});

test("a non-revision failure stops immediately and names the step", async () => {
    // Retrying an unreachable appliance would only multiply the wait before the
    // student is told anything.
    let trunkCalls = 0;
    const { order, dependencies } = harness({
        async applyAccessTrunk() {
            trunkCalls += 1;
            throw new Error("ssh channel down");
        },
    });
    await assert.rejects(
        () => ensureNetworkGroupInfrastructure(group(), "vu1234", dependencies),
        (error: NetworkProvisioningError) => (
            error.step === "access-trunk" && /ssh channel down/.test(error.message)
        ),
    );
    assert.equal(trunkCalls, 1);
    assert.deepEqual(order, ["vnet"]);
});

test("an attempt that finishes failed is a provisioning failure, not a success", async () => {
    // The runners record failures rather than throwing them, so a caller that
    // only watched for exceptions would hand out a VM with no path.
    const { dependencies } = harness({
        async applyAccessPolicy() {
            return attempt("3", {
                status: "failed",
                phase: "apply-failed",
                applied_revision: null,
                error_code: "access-apply-verify",
            });
        },
    });
    await assert.rejects(
        () => ensureNetworkGroupInfrastructure(group(), "vu1234", dependencies),
        (error: NetworkProvisioningError) => (
            error.step === "access-policy" && /access-apply-verify/.test(error.message)
        ),
    );
});

test("later steps are skipped once one fails", async () => {
    const { order, dependencies } = harness({
        async applyAccessPolicy() { throw new Error("nftables refused the ruleset"); },
    });
    await assert.rejects(() => ensureNetworkGroupInfrastructure(group(), "vu1234", dependencies));
    assert.deepEqual(order, ["vnet", "access-trunk"]);
});

test("a VNet failure is reported as the vnet step and stops everything else", async () => {
    const { order, dependencies } = harness({
        async ensureVnet() { throw new Error("SDN apply timed out"); },
    });
    await assert.rejects(
        () => ensureNetworkGroupInfrastructure(group(), "vu1234", dependencies),
        (error: NetworkProvisioningError) => error.step === "vnet",
    );
    assert.deepEqual(order, []);
});
