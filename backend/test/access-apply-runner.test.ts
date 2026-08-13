import assert from "node:assert/strict";
import test from "node:test";
import { QueryResult, QueryResultRow } from "pg";
import {
    AccessApplyClient,
    AccessApplyPlan,
    AccessStageResponse,
    buildAccessApplyPlan,
} from "../src/network/access-apply";
import {
    AccessApplyReadinessError,
    AccessApplyRevisionError,
    AccessApplyModeError,
    AccessApplyRunner,
    ACCESS_POLICY_RESOURCE,
} from "../src/network/access-apply-runner";
import { AccessHostObservation } from "../src/network/adapters/access";
import { buildInfrastructurePlan } from "../src/network/infrastructure-desired-state";
import {
    CheckpointReconciliationAttempt,
    FinishReconciliationAttempt,
    ReconciliationAttempt,
} from "../src/network/reconciliation-attempts";
import { InfrastructureApplyAttemptStore } from "../src/network/infrastructure-apply-runner";

function observation(
    revision: string,
    mutate: (root: AccessHostObservation) => void = () => {},
): AccessHostObservation {
    const root: AccessHostObservation = {
        version: 1,
        request_id: "00000000-0000-4000-8000-000000000000",
        target: "access",
        operation: "observe",
        captured_at: "2026-08-12T00:00:00Z",
        vmid: 200,
        status: "running",
        config_digest: "a".repeat(40),
        net1: { name: "eth1", bridge: "vmbr20", ip: "10.10.20.10/24", trunks: [2000, 2002] },
        host_veth: { name: "veth200i1", exists: true, vlan_ids: [2000, 2002] },
        guest: {
            version: 1,
            captured_at: "2026-08-12T00:00:00Z",
            hostname: "guacamole",
            interfaces: [
                { name: "eth0", addresses: ["10.10.10.50/24"] },
                { name: "eth1", addresses: [] },
                { name: "eth1.2002", addresses: ["10.200.2.2/24"] },
            ],
            docker_bridge_cidrs: ["172.18.0.0/16"],
            listeners: [
                { port: 8080, local_address: "10.10.10.50" },
                { port: 9443, local_address: "10.10.10.50" },
            ],
            connections: [],
            sysctl: { ipv4_forwarding: true, ipv6_enabled: false },
            nftables: {
                available: true,
                ruleset: `# Access desired-state revision ${revision}`,
            },
            errors: [],
        },
        errors: [],
    };
    mutate(root);
    return root;
}

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

const plan: AccessApplyPlan = buildAccessApplyPlan(infrastructurePlan, observation("unset"));

function converged(mutate: (root: AccessHostObservation) => void = () => {}): AccessHostObservation {
    return observation(plan.access.revision, mutate);
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

function applyClient(options: { failStage?: boolean } = {}): AccessApplyClient {
    const verification = options.failStage
        ? {
            observed_revision: null,
            revision_matches: false,
            service_ports_listening: ["8080"],
            converged: false,
        }
        : {
            observed_revision: plan.access.revision,
            revision_matches: true,
            service_ports_listening: ["8080", "9443"],
            converged: true,
        };
    return {
        async stage(): Promise<AccessStageResponse> {
            return {
                version: 1,
                request_id: "00000000-0000-4000-8000-000000000001",
                target: "access",
                operation: "stage",
                transaction_id: "ax-test",
                revision: plan.access.revision,
                validators: ["nft -c"],
                pruned: [],
                reloaded: ["networkd", "sysctl", "nftables"],
                nftables_include_added: false,
                verification,
                rollback_armed: true,
                rollback_seconds: 300,
            };
        },
        async commit(transactionId) {
            return {
                version: 1,
                request_id: "00000000-0000-4000-8000-000000000002",
                target: "access",
                operation: "commit",
                transaction_id: transactionId,
                revision: plan.access.revision,
                committed: true,
                rollback_armed: false,
                verification: {
                    observed_revision: plan.access.revision,
                    revision_matches: true,
                    service_ports_listening: ["8080", "9443"],
                    converged: true,
                },
            };
        },
        async rollback() { return {}; },
    };
}

test("records a succeeded attempt with the applied revision", async () => {
    const recording = recordingStore();
    const attempt = await new AccessApplyRunner({
        database: database(),
        apply: applyClient({}),
        observe: { async observe() { return converged(); } },
        getPlan: async () => infrastructurePlan,
        getMode: async () => "active" as const,
        createAttempts: () => recording.store,
    }).apply({ requestedBy: "admin", expectedRevision: infrastructurePlan.revision });

    assert.equal(attempt.status, "succeeded");
    assert.equal(attempt.phase, "applied");
    assert.equal(attempt.applied_revision, infrastructurePlan.revision);
    assert.equal(recording.abandonedCount(), 1, "must abandon stale running attempts first");
    assert.deepEqual(recording.checkpoints.map((entry) => entry.phase), ["planned", "applying"]);
    assert.deepEqual(recording.finishes[0].actions, [{
        component: "access",
        operation: "update",
        execution_state: "succeeded",
        resource: ACCESS_POLICY_RESOURCE,
        desired: { revision: plan.access.revision },
    }]);
});

test("refuses a stale expected revision before creating an attempt", async () => {
    const recording = recordingStore();

    await assert.rejects(
        () => new AccessApplyRunner({
            database: database(),
            apply: applyClient({}),
            observe: { async observe() { return converged(); } },
            getPlan: async () => infrastructurePlan,
            getMode: async () => "active" as const,
        createAttempts: () => recording.store,
        }).apply({ requestedBy: "admin", expectedRevision: "b".repeat(64) }),
        AccessApplyRevisionError,
    );
    assert.equal(recording.finishes.length, 0, "no attempt should be recorded");
});

/**
 * A guest that is drifted when first observed and converged afterwards, which
 * is what a real apply produces. `applyAccessPolicy` re-observes after staging,
 * so a fixture that stayed drifted would (correctly) refuse to commit.
 */
function healingObserver(drifted: AccessHostObservation) {
    let calls = 0;
    return {
        client: {
            async observe() {
                calls += 1;
                return calls === 1 ? drifted : converged();
            },
        },
        callCount: () => calls,
    };
}

test("drift the apply exists to fix does not block the apply", async () => {
    // The whole point of applying is that the guest does not match. A stale
    // ruleset and a missing VLAN subinterface must not be treated as blockers.
    const recording = recordingStore();
    const drifted = observation("c".repeat(64), (root) => {
        root.guest.interfaces = root.guest.interfaces.filter(({ name }) => name !== "eth1.2002");
        root.guest.sysctl.ipv4_forwarding = false;
    });
    const observer = healingObserver(drifted);

    const attempt = await new AccessApplyRunner({
        database: database(),
        apply: applyClient({}),
        observe: observer.client,
        getPlan: async () => infrastructurePlan,
        getMode: async () => "active" as const,
        createAttempts: () => recording.store,
    }).apply({ requestedBy: "admin", expectedRevision: infrastructurePlan.revision });

    assert.equal(attempt.status, "succeeded");
    assert.equal(observer.callCount(), 2, "observed once to plan, once to verify the commit");
});

test("a guest that does not converge after staging is not committed", async () => {
    // The same drift on both observations means the apply did not take effect.
    const recording = recordingStore();
    const drifted = observation("c".repeat(64));

    const attempt = await new AccessApplyRunner({
        database: database(),
        apply: applyClient({}),
        observe: { async observe() { return drifted; } },
        getPlan: async () => infrastructurePlan,
        getMode: async () => "active" as const,
        createAttempts: () => recording.store,
    }).apply({ requestedBy: "admin", expectedRevision: infrastructurePlan.revision });

    assert.equal(attempt.status, "failed");
    assert.equal(attempt.error_code, "access-apply-verify");
    assert.equal(attempt.applied_revision, null);
});

test("hypervisor-level drift blocks the apply instead of half-fixing it", async () => {
    // Writing files inside the container cannot retag the host veth, so applying
    // over this would produce a confusing partial success.
    const recording = recordingStore();
    const untagged = converged((root) => { root.host_veth.vlan_ids = [2000]; });

    const error = await new AccessApplyRunner({
        database: database(),
        apply: applyClient({}),
        observe: { async observe() { return untagged; } },
        getPlan: async () => infrastructurePlan,
        getMode: async () => "active" as const,
        createAttempts: () => recording.store,
    }).apply({ requestedBy: "admin", expectedRevision: infrastructurePlan.revision })
        .then(() => null, (caught) => caught);

    assert.ok(error instanceof AccessApplyReadinessError);
    assert.deepEqual(error.failedChecks, ["access-live-trunks"]);
    assert.equal(recording.finishes.length, 0);
});

test("a guest whose services stopped answering blocks the apply", async () => {
    // The applier does not start Guacamole, and the guest itself refuses to
    // commit while its published ports are silent.
    const recording = recordingStore();
    const silent = converged((root) => { root.guest.listeners = []; });

    const error = await new AccessApplyRunner({
        database: database(),
        apply: applyClient({}),
        observe: { async observe() { return silent; } },
        getPlan: async () => infrastructurePlan,
        getMode: async () => "active" as const,
        createAttempts: () => recording.store,
    }).apply({ requestedBy: "admin", expectedRevision: infrastructurePlan.revision })
        .then(() => null, (caught) => caught);

    assert.ok(error instanceof AccessApplyReadinessError);
    assert.deepEqual(error.failedChecks, [
        "access-guest-service-8080-binding",
        "access-guest-service-9443-binding",
    ]);
    assert.equal(recording.finishes.length, 0);
});

test("an unobservable guest is refused before any attempt is created", async () => {
    const recording = recordingStore();

    const error = await new AccessApplyRunner({
        database: database(),
        apply: applyClient({}),
        observe: { async observe() { throw new Error("Restricted SSH execution timed out"); } },
        getPlan: async () => infrastructurePlan,
        getMode: async () => "active" as const,
        createAttempts: () => recording.store,
    }).apply({ requestedBy: "admin", expectedRevision: infrastructurePlan.revision })
        .then(() => null, (caught) => caught);

    assert.ok(error instanceof AccessApplyReadinessError);
    assert.match(error.message, /access-observation/);
    assert.equal(recording.finishes.length, 0, "a guest that cannot be reached leaves no attempt");
});

test("a failed apply is recorded as compensated, not as a half-applied revision", async () => {
    // The guest armed a rollback timer before installing anything, so the
    // recorded outcome must not imply it is holding the new revision.
    const recording = recordingStore();

    const attempt = await new AccessApplyRunner({
        database: database(),
        apply: applyClient({ failStage: true }),
        observe: { async observe() { return converged(); } },
        getPlan: async () => infrastructurePlan,
        getMode: async () => "active" as const,
        createAttempts: () => recording.store,
    }).apply({ requestedBy: "admin", expectedRevision: infrastructurePlan.revision });

    assert.equal(attempt.status, "failed");
    assert.equal(attempt.phase, "apply-failed");
    assert.equal(attempt.applied_revision, null, "a failed apply must record no applied revision");
    assert.equal(attempt.actions[0].execution_state, "compensated");
    assert.equal(attempt.actions[0].resource, ACCESS_POLICY_RESOURCE);
    assert.equal(attempt.error_code, "access-apply-stage");
    assert.match(attempt.error_detail ?? "", /service port\(s\) not listening: 9443/);
});

test("the recorded checks are the pre-apply observation, not a claim of success", async () => {
    // Deliberately never converges, so the attempt fails; the point is that the
    // persisted checks describe what was seen BEFORE the apply.
    const recording = recordingStore();
    const drifted = observation("c".repeat(64), (root) => {
        root.guest.nftables = { available: false, ruleset: "" };
    });

    await new AccessApplyRunner({
        database: database(),
        apply: applyClient({}),
        observe: { async observe() { return drifted; } },
        getPlan: async () => infrastructurePlan,
        getMode: async () => "active" as const,
        createAttempts: () => recording.store,
    }).apply({ requestedBy: "admin", expectedRevision: infrastructurePlan.revision });

    const recorded = recording.finishes[0].checks.find(
        (check) => check.key === "access-guest-nftables-revision",
    );
    assert.equal(recorded?.status, "fail");
    assert.match(recorded?.detail ?? "", /nftables ruleset is unavailable/);
});

test("refuses to apply while the network mode is still legacy", async () => {
    // The ruleset permits Guacamole egress to lab VMs over VLAN interfaces only.
    // A legacy VM is on untagged eth1, so applying before the migration strands
    // it -- silently, because the apply itself converges and commits.
    const recording = recordingStore();
    const error = await new AccessApplyRunner({
        database: database(),
        apply: applyClient({}),
        observe: { async observe() { return converged() as never; } },
        getPlan: async () => infrastructurePlan,
        getMode: async () => "legacy" as const,
        createAttempts: () => recording.store,
    }).apply({ requestedBy: "admin", expectedRevision: infrastructurePlan.revision })
        .then(() => null, (caught) => caught);

    assert.ok(error instanceof AccessApplyModeError);
    assert.match(error.message, /legacy/);
    assert.equal(recording.finishes.length, 0, "no attempt may be recorded");
});

test("refuses in dry-run mode too, not only legacy", async () => {
    const recording = recordingStore();
    await assert.rejects(
        () => new AccessApplyRunner({
            database: database(),
            apply: applyClient({}),
            observe: { async observe() { return converged() as never; } },
            getPlan: async () => infrastructurePlan,
            getMode: async () => "dry-run" as const,
            createAttempts: () => recording.store,
        }).apply({ requestedBy: "admin", expectedRevision: infrastructurePlan.revision }),
        AccessApplyModeError,
    );
});

test("the mode is checked before the guest is observed at all", async () => {
    // Refusing early keeps a forbidden apply from touching the guest or the lock.
    let observed = false;
    await assert.rejects(
        () => new AccessApplyRunner({
            database: database(),
            apply: applyClient({}),
            observe: { async observe() { observed = true; return converged() as never; } },
            getPlan: async () => infrastructurePlan,
            getMode: async () => "legacy" as const,
            createAttempts: () => recordingStore().store,
        }).apply({ requestedBy: "admin", expectedRevision: infrastructurePlan.revision }),
        AccessApplyModeError,
    );
    assert.equal(observed, false, "a refused apply must not reach the guest");
});
