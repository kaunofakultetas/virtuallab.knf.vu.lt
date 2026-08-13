import assert from "node:assert/strict";
import test from "node:test";
import { InfrastructureApplyRevisionError } from "../src/network/infrastructure-apply-runner";
import { InfrastructurePlan } from "../src/network/infrastructure-desired-state";
import {
    ensureNetworkGroupVnet,
    NetworkGroupVnetError,
} from "../src/network/provisioning-vnet";
import { ReconciliationAttempt } from "../src/network/reconciliation-attempts";
import { NetworkGroup } from "../src/types/network-groups";

function buildGroup(overrides: Partial<NetworkGroup> = {}): NetworkGroup {
    return {
        id: 7,
        owner_id: "vu1234",
        profile_id: 3,
        vlan_tag: 2000,
        vnet_name: "lab2000",
        subnet_cidr: "10.200.0.0/24",
        state: "creating",
        desired_revision: null,
        applied_revision: null,
        last_error: null,
        created_at: new Date(0),
        updated_at: new Date(0),
        ...overrides,
    };
}

function buildPlan(revision: string, vnets = ["lab2000"]): InfrastructurePlan {
    return {
        revision,
        desired_state: {
            version: 1,
            migration: { preserved_access_vlans: [2000] },
            groups: [],
            proxmox: {
                vnets: vnets.map((vnet, index) => ({
                    vnet,
                    zone: "labzone",
                    tag: 2000 + index,
                })),
            },
            trunks: { access_vlan_ids: [2000], gateway_vlan_ids: [2000] },
        },
    } as InfrastructurePlan;
}

function buildAttempt(overrides: Partial<ReconciliationAttempt> = {}): ReconciliationAttempt {
    return {
        id: "11",
        request_id: "req",
        requested_by: "vu1234",
        idempotency_key: null,
        mode: "apply",
        status: "succeeded",
        desired_revision: "a".repeat(64),
        applied_revision: "a".repeat(64),
        phase: "verifying",
        checks: [],
        actions: [],
        error_code: null,
        error_detail: null,
        created_at: new Date(0),
        started_at: new Date(0),
        finished_at: new Date(0),
        ...overrides,
    } as ReconciliationAttempt;
}

test("applies the current plan revision and returns the attempt", async () => {
    const revision = "a".repeat(64);
    const applied: string[] = [];

    const attempt = await ensureNetworkGroupVnet(buildGroup(), "vu1234", {
        getPlan: async () => buildPlan(revision),
        applyVnets: async (input) => {
            applied.push(input.expectedRevision);
            return buildAttempt();
        },
    });

    assert.deepEqual(applied, [revision]);
    assert.equal(attempt.status, "succeeded");
});

test("re-reads the plan when a concurrent allocation moves the revision", async () => {
    const revisions = ["a".repeat(64), "b".repeat(64)];
    const seen: string[] = [];
    let call = 0;

    const attempt = await ensureNetworkGroupVnet(buildGroup(), "vu1234", {
        getPlan: async () => buildPlan(revisions[Math.min(call, revisions.length - 1)]),
        applyVnets: async (input) => {
            seen.push(input.expectedRevision);
            call += 1;
            if (call === 1) {
                throw new InfrastructureApplyRevisionError(input.expectedRevision, revisions[1]);
            }
            return buildAttempt();
        },
    });

    assert.deepEqual(seen, revisions);
    assert.equal(attempt.status, "succeeded");
});

test("gives up after the bounded revision retries", async () => {
    let calls = 0;

    await assert.rejects(
        ensureNetworkGroupVnet(buildGroup(), "vu1234", {
            revisionAttempts: 2,
            getPlan: async () => buildPlan("a".repeat(64)),
            applyVnets: async (input) => {
                calls += 1;
                throw new InfrastructureApplyRevisionError(input.expectedRevision, "c".repeat(64));
            },
        }),
        NetworkGroupVnetError,
    );
    assert.equal(calls, 2);
});

test("refuses a group that is not part of the operational plan", async () => {
    let applyCalls = 0;

    await assert.rejects(
        ensureNetworkGroupVnet(buildGroup(), "vu1234", {
            getPlan: async () => buildPlan("a".repeat(64), ["lab2001"]),
            applyVnets: async () => {
                applyCalls += 1;
                return buildAttempt();
            },
        }),
        /is not part of the operational plan/,
    );
    // Nothing may be mutated for a group the plan does not own.
    assert.equal(applyCalls, 0);
});

test("refuses a group without a VNet name before reading the plan", async () => {
    let planCalls = 0;

    await assert.rejects(
        ensureNetworkGroupVnet(buildGroup({ vnet_name: null }), "vu1234", {
            getPlan: async () => {
                planCalls += 1;
                return buildPlan("a".repeat(64));
            },
        }),
        NetworkGroupVnetError,
    );
    assert.equal(planCalls, 0);
});

test("fails when the apply attempt does not succeed", async () => {
    await assert.rejects(
        ensureNetworkGroupVnet(buildGroup(), "vu1234", {
            getPlan: async () => buildPlan("a".repeat(64)),
            applyVnets: async () => buildAttempt({
                status: "failed",
                applied_revision: null,
                error_code: "vnet-apply-failed",
            }),
        }),
        /finished failed \(vnet-apply-failed\)/,
    );
});

test("propagates a non-revision apply error unchanged", async () => {
    await assert.rejects(
        ensureNetworkGroupVnet(buildGroup(), "vu1234", {
            getPlan: async () => buildPlan("a".repeat(64)),
            applyVnets: async () => {
                throw new Error("proxmox unreachable");
            },
        }),
        /proxmox unreachable/,
    );
});
