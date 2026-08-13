import assert from "node:assert/strict";
import test from "node:test";
import { QueryResult, QueryResultRow } from "pg";
import {
    InfrastructureApplyReadinessError,
    InfrastructureApplyRevisionError,
    InfrastructureApplyRunner,
    InfrastructureApplyAttemptStore,
} from "../src/network/infrastructure-apply-runner";
import { buildInfrastructurePlan } from "../src/network/infrastructure-desired-state";
import { ReconciliationAttempt } from "../src/network/reconciliation-attempts";

function result<Row extends QueryResultRow>(rows: Row[]): QueryResult<Row> {
    return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

function baseAttempt(overrides: Partial<ReconciliationAttempt> = {}): ReconciliationAttempt {
    return {
        id: "9",
        request_id: "00000000-0000-4000-8000-000000000009",
        requested_by: "admin",
        idempotency_key: null,
        mode: "apply",
        status: "running",
        desired_revision: "a".repeat(64),
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
    };
}

function fixture(options: { zone?: boolean; revision?: string } = {}) {
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
    if (options.revision) plan.revision = options.revision;
    let released = false;
    let vnetExists = false;
    const creates: Array<{ mode: string; desiredRevision: string }> = [];
    const checkpoints: string[] = [];
    const client = {
        async query<Row extends QueryResultRow>(sql: string) {
            if (sql.includes("pg_try_advisory_lock")) {
                return result([{ acquired: true }] as unknown as Row[]);
            }
            return result([] as Row[]);
        },
        release() { released = true; },
    };
    const store: InfrastructureApplyAttemptStore = {
        async abandonRunning() { return 0; },
        async create(input) {
            creates.push({ mode: input.mode, desiredRevision: input.desiredRevision });
            return baseAttempt({
                requested_by: input.requestedBy,
                desired_revision: input.desiredRevision,
            });
        },
        async checkpoint(_id, input) {
            checkpoints.push(input.phase);
            return baseAttempt({ phase: input.phase, checks: input.checks, actions: input.actions });
        },
        async finish(_id, input) {
            return baseAttempt({
                status: input.status,
                phase: input.phase,
                checks: input.checks,
                actions: input.actions,
                applied_revision: input.appliedRevision ?? null,
                finished_at: new Date(1),
            });
        },
    };
    return {
        plan,
        creates,
        checkpoints,
        wasReleased: () => released,
        dependencies: {
            database: { async connect() { return client; } },
            async getPlan() { return plan; },
            createAttempts: () => store,
            proxmox: {
                async getSdnZones() {
                    return options.zone === false ? [] : [{ zone: "labzone", type: "vlan" }];
                },
                async getSdnVnets() {
                    return vnetExists
                        ? [{ vnet: "lab2001", zone: "labzone", tag: 2001 }]
                        : [];
                },
                async createSdnVnet() { vnetExists = true; },
                async updateSdnVnet() { throw new Error("unexpected update"); },
                async deleteSdnVnet() { vnetExists = false; },
                async applySdnConfiguration() { return null; },
                async waitForTask() { throw new Error("unexpected wait"); },
            },
            convergence: { attempts: 1 },
        },
    };
}

test("creates and applies a fresh VNet plan under the lock", async () => {
    const current = fixture();
    const completed = await new InfrastructureApplyRunner(current.dependencies).applyVnets({
        requestedBy: "admin",
        expectedRevision: current.plan.revision,
        idempotencyKey: "apply-1",
    });

    assert.equal(completed.phase, "applied");
    assert.equal(completed.applied_revision, current.plan.revision);
    assert.deepEqual(current.creates, [{ mode: "apply", desiredRevision: current.plan.revision }]);
    assert.deepEqual(current.checkpoints, ["planned", "applying", "verifying", "applying"]);
    assert.equal(current.wasReleased(), true);
});

test("rejects a stale revision before creating an apply attempt", async () => {
    const current = fixture();
    await assert.rejects(
        new InfrastructureApplyRunner(current.dependencies).applyVnets({
            requestedBy: "admin",
            expectedRevision: "f".repeat(64),
        }),
        InfrastructureApplyRevisionError,
    );
    assert.deepEqual(current.creates, []);
    assert.equal(current.wasReleased(), true);
});

test("rejects a missing SDN zone before creating an apply attempt", async () => {
    const current = fixture({ zone: false });
    await assert.rejects(
        new InfrastructureApplyRunner(current.dependencies).applyVnets({
            requestedBy: "admin",
            expectedRevision: current.plan.revision,
        }),
        InfrastructureApplyReadinessError,
    );
    assert.deepEqual(current.creates, []);
    assert.equal(current.wasReleased(), true);
});