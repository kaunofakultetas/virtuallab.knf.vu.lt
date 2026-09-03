// -----------------------------------------------------------
//  [*] Tests — the dry-run reconciler
//
//  Settled per-component observation, failing checks instead
//  of lost evidence, and sanitised persisted errors.
//
//  Covers src/network/infrastructure-reconciler.ts. Run with
//  `npm test` (the whole suite) inside the backend
//  container.
// -----------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import { QueryResult, QueryResultRow } from "pg";
import { buildInfrastructurePlan } from "../src/network/infrastructure-desired-state";
import { buildGatewayPlan } from "../src/network/gateway-desired-state";
import {
    InfrastructureReconciler,
    ReconciliationAttemptStore,
    ReconciliationRevisionError,
} from "../src/network/infrastructure-reconciler";
import {
    CheckpointReconciliationAttempt,
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

/**
 * A structurally valid Gateway observation. It is deliberately not converged
 * with any plan: these tests assert wiring, not check content, which
 * gateway-adapter.test.ts covers.
 */
function gatewayObservationFixture() {
    return {
        version: 1,
        request_id: "00000000-0000-4000-8000-000000000000",
        target: "gateway",
        operation: "observe",
        captured_at: "2026-08-12T00:00:00Z",
        vmid: 202,
        status: "running",
        config_digest: "a".repeat(40),
        network_devices: {
            net1: { bridge: "vmbr20", firewall: true, connected: true, trunks: [2000] },
            net2: { bridge: "vmbr0", firewall: true, connected: true, trunks: [] },
        },
        ip_config: { ipconfig0: "ip=10.10.10.2/24" },
        guest: {
            version: 1,
            captured_at: "2026-08-12T00:00:00Z",
            interfaces: [{ name: "eth0", addresses: ["10.10.10.2/24"], parent: null, operstate: "UP" }],
            vlan_interfaces: [],
            default_routes: [{ gateway: "172.16.0.1", interface: "eth2" }],
            nftables_revision: null,
            managed_files: {},
            services: {
                nftables: { active: true, enabled: true },
                dnsmasq: { active: true, enabled: true },
                squid: { active: true, enabled: true },
            },
            listeners: [],
            sysctl: { ipv4_forwarding: true, ipv6_disabled: true },
        },
        errors: [],
    };
}

function gatewayPlanFixture() {
    return buildGatewayPlan({
        groups: [],
        peerings: [],
        trunk_interface: "ens19",
        uplink_interface: "eth2",
        management_interface: "eth0",
        upstream_resolvers: ["1.1.1.1"],
        management_source_cidrs: ["10.10.10.100/32"],
    });
}

function dependencies(store: ReconciliationAttemptStore, options: {
    observedVnets?: Array<{ vnet: string; zone: string; tag: number }>;
    observationError?: Error;
    accessObservationError?: Error;
    accessObservation?: unknown;
    withGateway?: boolean;
    gatewayObservationError?: Error;
    gatewayPlanError?: Error;
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
            ...(options.withGateway
                ? {
                    gateway: {
                        async observe() {
                            if (options.gatewayObservationError) throw options.gatewayObservationError;
                            return gatewayObservationFixture() as never;
                        },
                    },
                    async getGatewayPlan() {
                        if (options.gatewayPlanError) throw options.gatewayPlanError;
                        return gatewayPlanFixture();
                    },
                }
                : {}),
            async getPlan() { return plan; },
            createAttempts: () => store,
        },
    };
}

function recordingStore() {
    const checkpoints: CheckpointReconciliationAttempt[] = [];
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
        async checkpoint(_id, input) {
            checkpoints.push(input);
            return attempt({ phase: input.phase });
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
    return { store, checkpoints, finishes };
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
    assert.deepEqual(recording.checkpoints, [{ phase: "planning" }]);
    assert.deepEqual(recording.finishes[0].actions.map((action: any) => action.operation), [
        "create",
    ]);
    assert.ok(recording.finishes[0].actions.every(
        (action) => action.execution_state === "planned",
    ));
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
test("omits Gateway checks entirely when no Gateway observer is configured", async () => {
    const recording = recordingStore();
    const fixture = dependencies(recording.store, { accessObservation: { version: 1 } });

    const completed = await new InfrastructureReconciler(fixture.value).dryRun({
        requestedBy: "admin",
        idempotencyKey: "no-gateway",
    });

    assert.equal(completed.status, "succeeded");
    assert.deepEqual(completed.checks.filter((check) => check.component === "gateway"), []);
});

test("records Gateway checks when an observer is configured", async () => {
    const recording = recordingStore();
    const fixture = dependencies(recording.store, {
        accessObservation: { version: 1 },
        withGateway: true,
    });

    const completed = await new InfrastructureReconciler(fixture.value).dryRun({
        requestedBy: "admin",
        idempotencyKey: "with-gateway",
    });

    const gatewayChecks = completed.checks.filter((check) => check.component === "gateway");
    assert.ok(gatewayChecks.length > 0, "expected Gateway checks");
    assert.ok(gatewayChecks.some((check) => check.key === "gateway-nftables-revision"));
});

test("a failed Gateway observation does not discard healthy evidence from other components", async () => {
    const recording = recordingStore();
    const fixture = dependencies(recording.store, {
        accessObservation: { version: 1 },
        withGateway: true,
        gatewayObservationError: new Error("restricted SSH execution timed out"),
    });

    const completed = await new InfrastructureReconciler(fixture.value).dryRun({
        requestedBy: "admin",
        idempotencyKey: "gateway-observation-failed",
    });

    assert.equal(completed.status, "succeeded");
    const observationCheck = completed.checks.find((check) => check.key === "gateway-observation");
    assert.equal(observationCheck?.status, "fail");
    assert.equal(observationCheck?.required, true);
    assert.ok(completed.checks.some(
        (check) => check.component === "proxmox-vnet" && check.status === "pass",
    ), "expected healthy Proxmox evidence to survive the Gateway failure");
});

test("an unconfigured Gateway plan is reported as a check, not a failed attempt", async () => {
    // getGatewayPlan fails closed when the guest interface names are unrecorded.
    // That must not take down a dry-run that still has useful Proxmox evidence.
    const recording = recordingStore();
    const fixture = dependencies(recording.store, {
        accessObservation: { version: 1 },
        withGateway: true,
        gatewayPlanError: new Error("settings.network.gateway.trunkInterface is not configured"),
    });

    const completed = await new InfrastructureReconciler(fixture.value).dryRun({
        requestedBy: "admin",
        idempotencyKey: "gateway-plan-unconfigured",
    });

    assert.equal(completed.status, "succeeded");
    const observationCheck = completed.checks.find((check) => check.key === "gateway-observation");
    assert.equal(observationCheck?.status, "fail");
    assert.match(observationCheck?.detail ?? "", /trunkInterface is not configured/);
});
