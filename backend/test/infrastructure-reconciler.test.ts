import assert from "node:assert/strict";
import test from "node:test";
import { QueryResult, QueryResultRow } from "pg";
import { buildInfrastructurePlan } from "../src/network/infrastructure-desired-state";
import {
    InfrastructureReconciler,
    ReconciliationAttemptStore,
    ReconciliationRevisionError,
} from "../src/network/infrastructure-reconciler";
import {
    FinishReconciliationAttempt,
    ReconciliationAttempt,
} from "../src/network/reconciliation-attempts";

function result<Row extends QueryResultRow>(rows: Row[]): QueryResult<Row> {
    return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

function attempt(overrides: Partial<ReconciliationAttempt> = {}): ReconciliationAttempt {
    return {
        id: "1",
        request_id: "00000000-0000-4000-8000-000000000001",
        requested_by: "admin",
        idempotency_key: null,
        mode: "dry-run",
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

function dependencies(store: ReconciliationAttemptStore, options: {
    observedVnets?: Array<{ vnet: string; zone: string; tag: number }>;
    observationError?: Error;
    accessObservationError?: Error;
    accessObservation?: unknown;
} = {}) {
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
    let released = false;
    const client = {
        async query<Row extends QueryResultRow>(sql: string) {
            if (sql.includes("pg_try_advisory_lock")) {
                return result([{ acquired: true }] as unknown as Row[]);
            }
            return result([] as Row[]);
        },
        release() { released = true; },
    };
    return {
        plan,
        wasReleased: () => released,
        value: {
            database: { async connect() { return client; } },
            proxmox: {
                async getSdnZones() {
                    if (options.observationError) throw options.observationError;
                    return [{ zone: "labzone", type: "simple" }];
                },
                async getSdnVnets() { return options.observedVnets ?? []; },
            },
            access: {
                async observe() {
                    if (options.accessObservationError) throw options.accessObservationError;
                    if (options.accessObservation !== undefined) return options.accessObservation as never;
                    throw new Error("Access fixture unavailable");
                },
            },
            async getPlan() { return plan; },
            createAttempts: () => store,
        },
    };
}

function recordingStore() {
    const finishes: FinishReconciliationAttempt[] = [];
    const store: ReconciliationAttemptStore = {
        async abandonRunning() { return 0; },
        async create(input) {
            return attempt({
                requested_by: input.requestedBy,
                desired_revision: input.desiredRevision,
                idempotency_key: input.idempotencyKey ?? null,
            });
        },
        async finish(_id, input) {
            finishes.push(input);
            return attempt({
                status: input.status,
                phase: input.phase,
                checks: input.checks,
                actions: input.actions,
                error_code: input.errorCode ?? null,
                error_detail: input.errorDetail ?? null,
                finished_at: new Date(1),
            });
        },
    };
    return { store, finishes };
}

test("records a deterministic dry-run without mutating Proxmox", async () => {
    const recording = recordingStore();
    const fixture = dependencies(recording.store);
    const reconciler = new InfrastructureReconciler(fixture.value);

    const completed = await reconciler.dryRun({
        requestedBy: "admin",
        expectedRevision: fixture.plan.revision,
        idempotencyKey: "request-1",
    });

    assert.equal(completed.status, "succeeded");
    assert.deepEqual(recording.finishes[0].actions.map((action: any) => action.operation), [
        "create",
    ]);
    assert.equal(fixture.wasReleased(), true);
});

test("records observation failures and releases the lock", async () => {
    const recording = recordingStore();
    const fixture = dependencies(recording.store, {
        observationError: new Error("Authorization: PVEAPIToken=admin!network=private-value"),
    });

    const completed = await new InfrastructureReconciler(fixture.value).dryRun({
        requestedBy: "admin",
    });

    assert.equal(completed.status, "succeeded");
    const proxmoxCheck = recording.finishes[0].checks.find(
        (check) => check.key === "proxmox-vnet-observation",
    );
    assert.doesNotMatch(proxmoxCheck?.detail ?? "", /private-value/);
    assert.match(proxmoxCheck?.detail ?? "", /\[redacted\]/);
    assert.equal(fixture.wasReleased(), true);
});

test("preserves Proxmox planning when Access observation fails", async () => {
    const recording = recordingStore();
    const fixture = dependencies(recording.store, {
        accessObservationError: new Error("Access observer unavailable"),
    });

    const completed = await new InfrastructureReconciler(fixture.value).dryRun({
        requestedBy: "admin",
    });

    assert.equal(completed.status, "succeeded");
    assert.ok(recording.finishes[0].actions.some((action) => action.component === "proxmox-vnet"));
    assert.equal(
        recording.finishes[0].checks.find((check) => check.key === "access-observation")?.status,
        "fail",
    );
    assert.equal(fixture.wasReleased(), true);
});

test("preserves Proxmox planning when the Access observation is malformed", async () => {
    const recording = recordingStore();
    const fixture = dependencies(recording.store, { accessObservation: { version: 1 } });

    const completed = await new InfrastructureReconciler(fixture.value).dryRun({
        requestedBy: "admin",
    });

    assert.equal(completed.status, "succeeded");
    assert.ok(recording.finishes[0].actions.some((action) => action.component === "proxmox-vnet"));
    assert.equal(
        recording.finishes[0].checks.find((check) => check.key === "access-observation")?.status,
        "fail",
    );
});

test("rejects a stale expected revision before creating an attempt", async () => {
    const recording = recordingStore();
    const fixture = dependencies(recording.store);

    await assert.rejects(
        new InfrastructureReconciler(fixture.value).dryRun({
            requestedBy: "admin",
            expectedRevision: "f".repeat(64),
        }),
        ReconciliationRevisionError,
    );
    assert.equal(recording.finishes.length, 0);
    assert.equal(fixture.wasReleased(), true);
});