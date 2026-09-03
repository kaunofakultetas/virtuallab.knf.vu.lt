// -----------------------------------------------------------
//  [*] Tests — the Access trunk apply runner
//
//  The mode gate, revision pinning, the unobservable-veth
//  refusal, and no-change attempts recorded as succeeded.
//
//  Covers src/network/access-trunk-runner.ts. Run with `npm
//  test` (the whole suite) inside the backend container.
// -----------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import { QueryResult, QueryResultRow } from "pg";
import {
    AccessTrunkApplyClient,
    AccessTrunkApplyResponse,
    AccessTrunkCommitResponse,
    AccessTrunkObserveResponse,
} from "../src/network/access-trunk-apply";
import {
    AccessTrunkApplyRunner,
    AccessTrunkModeError,
    AccessTrunkReadinessError,
    AccessTrunkRevisionError,
    ACCESS_TRUNK_RESOURCE,
    buildAccessTrunkPlan,
} from "../src/network/access-trunk-runner";
import { AccessHostObservation } from "../src/network/adapters/access";
import { buildInfrastructurePlan } from "../src/network/infrastructure-desired-state";
import {
    CheckpointReconciliationAttempt,
    FinishReconciliationAttempt,
    ReconciliationAttempt,
} from "../src/network/reconciliation-attempts";
import { InfrastructureApplyAttemptStore } from "../src/network/infrastructure-apply-runner";

const NET1 = "name=eth1,bridge=vmbr20,host-managed=0,hwaddr=BC:24:11:60:E1:F1,trunks=2000,type=veth";

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

function observation(
    trunks: number[],
    vlanIds: number[],
    vethExists = true,
): AccessHostObservation {
    return {
        version: 1,
        request_id: "00000000-0000-4000-8000-000000000000",
        target: "access",
        operation: "observe",
        captured_at: "2026-08-12T00:00:00Z",
        vmid: 200,
        status: "running",
        config_digest: "a".repeat(40),
        net1: { name: "eth1", bridge: "vmbr20", ip: null, trunks },
        host_veth: { name: "veth200i1", exists: vethExists, vlan_ids: vlanIds },
        guest: {
            version: 1,
            captured_at: "2026-08-12T00:00:00Z",
            hostname: "guacamole",
            interfaces: [],
            docker_bridge_cidrs: [],
            listeners: [],
            connections: [],
            sysctl: { ipv4_forwarding: true, ipv6_enabled: false },
            nftables: { available: true, ruleset: "" },
            errors: [],
        },
        errors: [],
    };
}

function recordingStore() {
    const checkpoints: CheckpointReconciliationAttempt[] = [];
    const finishes: FinishReconciliationAttempt[] = [];
    let abandoned = 0;
    const base = (overrides: Partial<ReconciliationAttempt> = {}): ReconciliationAttempt => ({
        id: "77",
        request_id: "00000000-0000-4000-8000-000000000009",
        requested_by: "vu1234",
        idempotency_key: null,
        mode: "apply",
        status: "running",
        desired_revision: infrastructurePlan.revision,
        applied_revision: null,
        phase: "initializing",
        checks: [],
        actions: [],
        error_code: null,
        error_detail: null,
        created_at: new Date(0),
        started_at: new Date(0),
        finished_at: null,
        ...overrides,
    });
    const store: InfrastructureApplyAttemptStore = {
        async abandonRunning() { abandoned += 1; return 0; },
        async create(input) {
            return base({ requested_by: input.requestedBy, desired_revision: input.desiredRevision });
        },
        async checkpoint(_id, input) { checkpoints.push(input); return base({ phase: input.phase }); },
        async finish(_id, input) {
            finishes.push(input);
            return base({
                status: input.status,
                phase: input.phase,
                checks: input.checks,
                actions: input.actions,
                applied_revision: input.appliedRevision ?? null,
                error_code: input.errorCode ?? null,
                error_detail: input.errorDetail ?? null,
            });
        },
    };
    return { store, checkpoints, finishes, abandonedCount: () => abandoned };
}

function database() {
    return {
        async connect() {
            return {
                async query<Row extends QueryResultRow>(sql: string): Promise<QueryResult<Row>> {
                    const rows = sql.includes("pg_try_advisory_lock")
                        ? ([{ acquired: true }] as unknown as Row[])
                        : ([] as Row[]);
                    return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
                },
                release() {},
            };
        },
    };
}

function trunkClient(options: { converged?: boolean } = {}) {
    const calls: string[] = [];
    const client: AccessTrunkApplyClient = {
        async observe(): Promise<AccessTrunkObserveResponse> {
            calls.push("observe");
            return {
                version: 1,
                request_id: "00000000-0000-4000-8000-000000000001",
                target: "access-trunk",
                operation: "observe",
                captured_at: "2026-08-12T00:00:00Z",
                net1: NET1,
                persistent_vlan_ids: [2000],
                live_veth_present: true,
                live_vlan_ids: [2000],
            };
        },
        async apply(input): Promise<AccessTrunkApplyResponse> {
            calls.push("apply");
            return {
                version: 1,
                request_id: "00000000-0000-4000-8000-000000000002",
                target: "access-trunk",
                operation: "apply",
                captured_at: "2026-08-12T00:00:00Z",
                transaction_id: "tr-test",
                desired_vlan_ids: input.desiredVlanIds,
                persistent_changed: true,
                added: [2002],
                removed: [],
                observed: {
                    net1: NET1,
                    persistent_vlan_ids: input.desiredVlanIds,
                    live_veth_present: true,
                    live_vlan_ids: input.desiredVlanIds,
                },
                converged: options.converged ?? true,
                rollback_armed: true,
                rollback_seconds: 300,
            };
        },
        async commit(transactionId): Promise<AccessTrunkCommitResponse> {
            calls.push("commit");
            return {
                version: 1,
                request_id: "00000000-0000-4000-8000-000000000003",
                target: "access-trunk",
                operation: "commit",
                captured_at: "2026-08-12T00:00:00Z",
                transaction_id: transactionId,
                committed: true,
                rollback_armed: false,
                observed: {
                    net1: NET1,
                    persistent_vlan_ids: [2000, 2002],
                    live_veth_present: true,
                    live_vlan_ids: [2000, 2002],
                },
            };
        },
        async rollback() { calls.push("rollback"); return {}; },
    };
    return { client, calls };
}

/**
 * The runner uses one observer for two different jobs: planning, and the
 * cross-channel proof after the change. Handing it a single fixed observation
 * would make those indistinguishable, so this returns each observation in turn
 * and repeats the last one.
 */
function runner(
    observations: AccessHostObservation[],
    options: { converged?: boolean; mode?: "legacy" | "dry-run" | "active" } = {},
) {
    const recorder = recordingStore();
    const { client, calls } = trunkClient({ converged: options.converged });
    let index = 0;
    return {
        recorder,
        calls,
        runner: new AccessTrunkApplyRunner({
            database: database(),
            apply: client,
            observe: {
                async observe() {
                    const observed = observations[Math.min(index, observations.length - 1)];
                    index += 1;
                    return observed;
                },
            },
            getPlan: async () => infrastructurePlan,
            createAttempts: () => recorder.store,
            getMode: async () => options.mode ?? "active",
        }),
    };
}

test("the plan is derived from the host observation's two trunk halves", () => {
    const plan = buildAccessTrunkPlan(infrastructurePlan, observation([2000], [2000, 2002]));
    assert.deepEqual(plan.desired_vlan_ids, [2000, 2002]);
    assert.equal(plan.persistent.status, "drifted");
    assert.equal(plan.live.status, "satisfied");
});

test("a non-active mode is refused before the lock is taken", async () => {
    // Desired membership comes from operational groups, and no group is
    // operational outside active mode, so a reconcile could only ever strip
    // membership something else put there.
    const harness = runner([observation([2000], [2000])], { mode: "legacy" });
    await assert.rejects(
        () => harness.runner.apply({ requestedBy: "vu1234", expectedRevision: infrastructurePlan.revision }),
        AccessTrunkModeError,
    );
    assert.equal(harness.recorder.abandonedCount(), 0);
    assert.deepEqual(harness.calls, []);
});

test("a stale expected revision is refused", async () => {
    const harness = runner([observation([2000], [2000])]);
    await assert.rejects(
        () => harness.runner.apply({ requestedBy: "vu1234", expectedRevision: "b".repeat(64) }),
        AccessTrunkRevisionError,
    );
    assert.deepEqual(harness.recorder.finishes, []);
});

test("an absent host veth blocks the apply instead of writing a trunk it cannot verify", async () => {
    // `pct set` would still succeed, and the live half would stay unprovable, so
    // the apply would report a convergence it never observed.
    const harness = runner([observation([2000], [], false)]);
    await assert.rejects(
        () => harness.runner.apply({
            requestedBy: "vu1234",
            expectedRevision: infrastructurePlan.revision,
        }),
        (error: AccessTrunkReadinessError) => (
            error instanceof AccessTrunkReadinessError
            && error.failedChecks.includes("access-trunk-live")
        ),
    );
    assert.deepEqual(harness.calls, []);
});

test("an unreachable observer never leaves a running attempt behind", async () => {
    const recorder = recordingStore();
    const { client } = trunkClient();
    const failing = new AccessTrunkApplyRunner({
        database: database(),
        apply: client,
        observe: { async observe(): Promise<AccessHostObservation> { throw new Error("ssh failed"); } },
        getPlan: async () => infrastructurePlan,
        createAttempts: () => recorder.store,
        getMode: async () => "active",
    });
    await assert.rejects(
        () => failing.apply({ requestedBy: "vu1234", expectedRevision: infrastructurePlan.revision }),
        AccessTrunkReadinessError,
    );
    assert.deepEqual(recorder.finishes, []);
});

test("an already-converged trunk records a succeeded attempt with no actions", async () => {
    // "Already converged" and "never asked" are different facts, and only the
    // attempt record can tell them apart later.
    const harness = runner([observation([2000, 2002], [2000, 2002])]);
    const attempt = await harness.runner.apply({
        requestedBy: "vu1234",
        expectedRevision: infrastructurePlan.revision,
    });
    assert.equal(attempt.status, "succeeded");
    assert.deepEqual(attempt.actions, []);
    assert.equal(attempt.applied_revision, infrastructurePlan.revision);
    assert.deepEqual(harness.calls, []);
});

test("a drifted trunk is applied and the attempt records the action as succeeded", async () => {
    // Drifted when planned, converged when proved: the second observation is
    // the independent evidence the commit is authorised by.
    const harness = runner([
        observation([2000], [2000]),
        observation([2000, 2002], [2000, 2002]),
    ]);
    const attempt = await harness.runner.apply({
        requestedBy: "vu1234",
        expectedRevision: infrastructurePlan.revision,
    });
    assert.equal(attempt.status, "succeeded");
    assert.deepEqual(attempt.actions, [{
        component: "access",
        operation: "update",
        execution_state: "succeeded",
        resource: ACCESS_TRUNK_RESOURCE,
        desired: { vlan_ids: [2000, 2002] },
    }]);
    assert.deepEqual(harness.calls, ["observe", "apply", "commit"]);
});

test("a failed apply records the action as compensated, not merely failed", async () => {
    // The host's timer is armed, so the change is already on its way out.
    // Recording it as failed would imply the trunk was left half-applied.
    const harness = runner([
        observation([2000], [2000]),
        observation([2000, 2002], [2000, 2002]),
    ], { converged: false });
    const attempt = await harness.runner.apply({
        requestedBy: "vu1234",
        expectedRevision: infrastructurePlan.revision,
    });
    assert.equal(attempt.status, "failed");
    assert.equal(attempt.actions[0].execution_state, "compensated");
    assert.equal(attempt.error_code, "access-trunk-apply");
    assert.equal(attempt.applied_revision, null);
    assert.ok(harness.calls.includes("rollback"));
});

test("every attempt grades both trunk halves and the migration VLAN", async () => {
    const harness = runner([observation([2000, 2002], [2000, 2002])]);
    await harness.runner.apply({
        requestedBy: "vu1234",
        expectedRevision: infrastructurePlan.revision,
    });
    const keys = harness.recorder.finishes[0].checks.map(({ key }) => key).sort();
    assert.deepEqual(keys, [
        "access-trunk-live",
        "access-trunk-migration-vlan",
        "access-trunk-persistent",
    ]);
});
