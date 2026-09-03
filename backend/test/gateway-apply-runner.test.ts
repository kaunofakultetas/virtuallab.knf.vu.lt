// -----------------------------------------------------------
//  [*] Tests — the Gateway apply runner
//
//  Revision pinning, fixable-check gating, and the
//  compensated action states on failure.
//
//  Covers src/network/gateway-apply-runner.ts. Run with `npm
//  test` (the whole suite) inside the backend container.
// -----------------------------------------------------------

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { QueryResult, QueryResultRow } from "pg";
import {
    buildGatewayPlan,
    GatewayDesiredStateInput,
    GatewayPlan,
} from "../src/network/gateway-desired-state";
import { renderedGatewayFiles } from "../src/network/adapters/gateway";
import {
    GatewayApplyReadinessError,
    GatewayApplyRevisionError,
    GatewayApplyRunner,
    GATEWAY_POLICY_RESOURCE,
} from "../src/network/gateway-apply-runner";
import { GatewayApplyClient } from "../src/network/gateway-apply";
import {
    CheckpointReconciliationAttempt,
    FinishReconciliationAttempt,
    ReconciliationAttempt,
} from "../src/network/reconciliation-attempts";
import { InfrastructureApplyAttemptStore } from "../src/network/infrastructure-apply-runner";
import { networkProjectionConfig } from "../src/network/config";

function baseInput(overrides: Partial<GatewayDesiredStateInput> = {}): GatewayDesiredStateInput {
    return {
        groups: [],
        peerings: [],
        trunk_interface: "ens19",
        uplink_interface: "eth2",
        management_interface: "eth0",
        upstream_resolvers: ["1.1.1.1"],
        management_source_cidrs: ["10.10.10.1/32", "10.10.10.100/32"],
        ...overrides,
    };
}

const APPROVED_VLANS = Array.from(
    { length: networkProjectionConfig.vlan.last - networkProjectionConfig.vlan.first + 1 },
    (_unused, index) => networkProjectionConfig.vlan.first + index,
);

function observation(plan: GatewayPlan, mutate: (guest: any, root: any) => void = () => {}) {
    const files = renderedGatewayFiles(plan);
    const desired = plan.desired_state;
    const root: any = {
        version: 1,
        request_id: "00000000-0000-4000-8000-000000000000",
        target: "gateway",
        operation: "observe",
        captured_at: "2026-08-12T00:00:00Z",
        vmid: 202,
        status: "running",
        config_digest: "a".repeat(40),
        network_devices: {
            net1: { bridge: "vmbr20", firewall: true, connected: true, trunks: APPROVED_VLANS },
            net2: { bridge: "vmbr0", firewall: true, connected: true, trunks: [] },
        },
        ip_config: { ipconfig0: "ip=10.10.10.2/24" },
        guest: {
            version: 1,
            captured_at: "2026-08-12T00:00:00Z",
            interfaces: [
                { name: "eth0", addresses: [desired.management.address_cidr], parent: null, operstate: "UP" },
                { name: "eth2", addresses: ["172.16.0.36/22"], parent: null, operstate: "UP" },
                { name: "ens19", addresses: [], parent: null, operstate: "DOWN" },
            ],
            vlan_interfaces: [],
            default_routes: [{ gateway: "172.16.0.1", interface: "eth2" }],
            nftables_revision: plan.revision,
            managed_files: Object.fromEntries(
                Object.entries(files).map(([path, content]) => [
                    path,
                    createHash("sha256").update(content).digest("hex"),
                ]),
            ),
            services: {
                nftables: { active: true, enabled: true },
                dnsmasq: { active: true, enabled: true },
                squid: { active: true, enabled: true },
            },
            listeners: [{ protocol: "udp", address: "127.0.0.1", port: 53 }],
            sysctl: { ipv4_forwarding: true, ipv6_disabled: true },
        },
        errors: [],
    };
    mutate(root.guest, root);
    return root;
}

function recordingStore() {
    const checkpoints: CheckpointReconciliationAttempt[] = [];
    const finishes: FinishReconciliationAttempt[] = [];
    let abandoned = 0;
    const base = (overrides: Partial<ReconciliationAttempt> = {}): ReconciliationAttempt => ({
        id: "42",
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

function applyClient(plan: GatewayPlan, options: { failStage?: boolean } = {}): GatewayApplyClient {
    return {
        async stage() {
            return {
                version: 1,
                request_id: "00000000-0000-4000-8000-000000000001",
                target: "gateway",
                operation: "stage",
                transaction_id: "gw-test",
                revision: plan.revision,
                validators: ["nft -c"],
                pruned: [],
                reloaded: ["nftables"],
                verification: options.failStage
                    ? { services_inactive: ["squid"], observed_revision: plan.revision, revision_matches: true, converged: false }
                    : { services_inactive: [], observed_revision: plan.revision, revision_matches: true, converged: true },
                rollback_armed: true,
                rollback_seconds: 300,
            } as never;
        },
        async commit(id) {
            return {
                version: 1,
                request_id: "00000000-0000-4000-8000-000000000002",
                target: "gateway",
                operation: "commit",
                transaction_id: id,
                revision: plan.revision,
                committed: true,
                rollback_armed: false,
                verification: { services_inactive: [], observed_revision: plan.revision, revision_matches: true, converged: true },
            } as never;
        },
        async rollback() { return {}; },
    };
}

test("records a succeeded attempt with the applied revision", async () => {
    const plan = buildGatewayPlan(baseInput());
    const recording = recordingStore();
    const attempt = await new GatewayApplyRunner({
        database: database(),
        apply: applyClient(plan),
        observe: { async observe() { return observation(plan) as never; } },
        getPlan: async () => plan,
        createAttempts: () => recording.store,
    }).apply({ requestedBy: "admin", expectedRevision: plan.revision });

    assert.equal(attempt.status, "succeeded");
    assert.equal(attempt.phase, "applied");
    assert.equal(attempt.applied_revision, plan.revision);
    assert.equal(recording.abandonedCount(), 1, "must abandon stale running attempts first");
    assert.deepEqual(recording.checkpoints.map((entry) => entry.phase), ["planned", "applying"]);
    assert.deepEqual(recording.finishes[0].actions, [{
        component: "gateway",
        operation: "update",
        execution_state: "succeeded",
        resource: GATEWAY_POLICY_RESOURCE,
        desired: { revision: plan.revision },
    }]);
});

test("refuses a stale expected revision before creating an attempt", async () => {
    const plan = buildGatewayPlan(baseInput());
    const recording = recordingStore();

    await assert.rejects(
        () => new GatewayApplyRunner({
            database: database(),
            apply: applyClient(plan),
            observe: { async observe() { return observation(plan) as never; } },
            getPlan: async () => plan,
            createAttempts: () => recording.store,
        }).apply({ requestedBy: "admin", expectedRevision: "b".repeat(64) }),
        GatewayApplyRevisionError,
    );
    assert.equal(recording.finishes.length, 0, "no attempt should be recorded");
});

/**
 * A guest that is drifted when first observed and converged afterwards, which
 * is what a real apply produces. `applyGatewayPolicy` re-observes after staging,
 * so a fixture that stayed drifted would (correctly) refuse to commit.
 */
function healingObserver(plan: GatewayPlan, drifted: unknown) {
    let calls = 0;
    return {
        client: {
            async observe() {
                calls += 1;
                return (calls === 1 ? drifted : observation(plan)) as never;
            },
        },
        callCount: () => calls,
    };
}

test("drift the apply exists to fix does not block the apply", async () => {
    // The whole point of applying is that the guest does not match. A stale
    // ruleset and mismatched files must not be treated as blockers.
    const plan = buildGatewayPlan(baseInput());
    const recording = recordingStore();
    const drifted = observation(plan, (guest) => {
        guest.nftables_revision = "c".repeat(64);
        guest.managed_files["/etc/squid/squid.conf"] = "d".repeat(64);
    });
    const observer = healingObserver(plan, drifted);

    const attempt = await new GatewayApplyRunner({
        database: database(),
        apply: applyClient(plan),
        observe: observer.client,
        getPlan: async () => plan,
        createAttempts: () => recording.store,
    }).apply({ requestedBy: "admin", expectedRevision: plan.revision });

    assert.equal(attempt.status, "succeeded");
    assert.equal(observer.callCount(), 2, "observed once to plan, once to verify the commit");
});

test("a guest that does not converge after staging is not committed", async () => {
    // The same drift on both observations means the apply did not take effect.
    const plan = buildGatewayPlan(baseInput());
    const recording = recordingStore();
    const drifted = observation(plan, (guest) => { guest.nftables_revision = "c".repeat(64); });

    const attempt = await new GatewayApplyRunner({
        database: database(),
        apply: applyClient(plan),
        observe: { async observe() { return drifted as never; } },
        getPlan: async () => plan,
        createAttempts: () => recording.store,
    }).apply({ requestedBy: "admin", expectedRevision: plan.revision });

    assert.equal(attempt.status, "failed");
    assert.equal(attempt.error_code, "gateway-apply-verify");
    assert.equal(attempt.applied_revision, null);
});

test("hypervisor-level drift blocks the apply instead of half-fixing it", async () => {
    // Writing files cannot connect a NIC, so applying over this would produce a
    // confusing partial success.
    const plan = buildGatewayPlan(baseInput());
    const recording = recordingStore();
    const disconnected = observation(plan, (_guest, root) => {
        root.network_devices.net2.connected = false;
    });

    const error = await new GatewayApplyRunner({
        database: database(),
        apply: applyClient(plan),
        observe: { async observe() { return disconnected as never; } },
        getPlan: async () => plan,
        createAttempts: () => recording.store,
    }).apply({ requestedBy: "admin", expectedRevision: plan.revision })
        .then(() => null, (caught) => caught);

    assert.ok(error instanceof GatewayApplyReadinessError);
    assert.deepEqual(error.failedChecks, ["gateway-uplink-connected"]);
    assert.equal(recording.finishes.length, 0);
});

test("an unobservable guest is refused before any attempt is created", async () => {
    const plan = buildGatewayPlan(baseInput());
    const recording = recordingStore();

    const error = await new GatewayApplyRunner({
        database: database(),
        apply: applyClient(plan),
        observe: { async observe() { throw new Error("Restricted SSH execution timed out"); } },
        getPlan: async () => plan,
        createAttempts: () => recording.store,
    }).apply({ requestedBy: "admin", expectedRevision: plan.revision })
        .then(() => null, (caught) => caught);

    assert.ok(error instanceof GatewayApplyReadinessError);
    assert.match(error.message, /gateway-observation/);
    assert.equal(recording.finishes.length, 0, "a guest that cannot be reached leaves no attempt");
});

test("a failed apply is recorded as compensated, not as a half-applied revision", async () => {
    // The guest armed a rollback timer before installing anything, so the
    // recorded outcome must not imply it is holding the new revision.
    const plan = buildGatewayPlan(baseInput());
    const recording = recordingStore();

    const attempt = await new GatewayApplyRunner({
        database: database(),
        apply: applyClient(plan, { failStage: true }),
        observe: { async observe() { return observation(plan) as never; } },
        getPlan: async () => plan,
        createAttempts: () => recording.store,
    }).apply({ requestedBy: "admin", expectedRevision: plan.revision });

    assert.equal(attempt.status, "failed");
    assert.equal(attempt.phase, "apply-failed");
    assert.equal(attempt.applied_revision, null, "a failed apply must record no applied revision");
    assert.equal(attempt.actions[0].execution_state, "compensated");
    assert.equal(attempt.error_code, "gateway-apply-stage");
    assert.match(attempt.error_detail ?? "", /inactive service/);
});

test("the recorded checks are the pre-apply observation, not a claim of success", async () => {
    // Deliberately never converges, so the attempt fails; the point is that the
    // persisted checks describe what was seen BEFORE the apply.
    const plan = buildGatewayPlan(baseInput());
    const recording = recordingStore();
    const drifted = observation(plan, (guest) => { guest.nftables_revision = null; });

    await new GatewayApplyRunner({
        database: database(),
        apply: applyClient(plan),
        observe: { async observe() { return drifted as never; } },
        getPlan: async () => plan,
        createAttempts: () => recording.store,
    }).apply({ requestedBy: "admin", expectedRevision: plan.revision });

    const recorded = recording.finishes[0].checks.find(
        (check) => check.key === "gateway-nftables-revision",
    );
    assert.equal(recorded?.status, "fail");
    assert.match(recorded?.detail ?? "", /No managed nftables table is loaded/);
});
