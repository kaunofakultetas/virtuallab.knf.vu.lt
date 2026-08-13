import assert from "node:assert/strict";
import test from "node:test";
import {
    AccessApplyClient,
    AccessApplyError,
    AccessApplyPlan,
    AccessStageResponse,
    applyAccessPolicy,
    buildAccessApplyPlan,
    renderedAccessFiles,
    RestrictedSshAccessApplyClient,
} from "../src/network/access-apply";
import { AccessHostObservation, planAccess } from "../src/network/adapters/access";
import { buildInfrastructurePlan } from "../src/network/infrastructure-desired-state";

const DOCKER_BRIDGE_CIDRS = ["172.18.0.0/16"];

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
            docker_bridge_cidrs: [...DOCKER_BRIDGE_CIDRS],
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

// The policy revision depends on the guest's Docker bridges, so the plan is
// derived from an observation exactly as the runner derives it.
const plan: AccessApplyPlan = buildAccessApplyPlan(infrastructurePlan, observation("unset"));

function converged(mutate: (root: AccessHostObservation) => void = () => {}): AccessHostObservation {
    return observation(plan.access.revision, mutate);
}

function stageResponse(overrides: Partial<AccessStageResponse> = {}): AccessStageResponse {
    return {
        version: 1,
        request_id: "00000000-0000-4000-8000-000000000001",
        target: "access",
        operation: "stage",
        transaction_id: "ax-20260812T000000Z",
        revision: plan.access.revision,
        validators: ["nft -c", "sysctl content check"],
        pruned: [],
        reloaded: ["networkd", "sysctl", "nftables"],
        nftables_include_added: false,
        verification: {
            observed_revision: plan.access.revision,
            revision_matches: true,
            service_ports_listening: ["8080", "9443"],
            converged: true,
        },
        rollback_armed: true,
        rollback_seconds: 300,
        ...overrides,
    };
}

function commitResponse(transactionId: string, rollbackArmed = false) {
    return {
        version: 1,
        request_id: "00000000-0000-4000-8000-000000000002",
        target: "access",
        operation: "commit",
        transaction_id: transactionId,
        revision: plan.access.revision,
        committed: true,
        rollback_armed: rollbackArmed,
        verification: {
            observed_revision: plan.access.revision,
            revision_matches: true,
            service_ports_listening: ["8080", "9443"],
            converged: true,
        },
    } as never;
}

type Recorder = {
    client: AccessApplyClient;
    calls: string[];
};

function recordingApplyClient(
    options: {
        stage?: Partial<AccessStageResponse>;
        commitRollbackArmed?: boolean;
        rollbackError?: Error;
    } = {},
): Recorder {
    const calls: string[] = [];
    return {
        calls,
        client: {
            async stage() {
                calls.push("stage");
                return stageResponse(options.stage);
            },
            async commit(transactionId) {
                calls.push("commit");
                return commitResponse(transactionId, options.commitRollbackArmed ?? false);
            },
            async rollback() {
                calls.push("rollback");
                if (options.rollbackError) throw options.rollbackError;
                return {};
            },
        },
    };
}

function observer(value: AccessHostObservation | null, error?: Error) {
    let calls = 0;
    return {
        client: {
            async observe() {
                calls += 1;
                if (error) throw error;
                return value as AccessHostObservation;
            },
        },
        callCount: () => calls,
    };
}

test("commits only after an independent observation agrees the guest converged", async () => {
    const apply = recordingApplyClient();
    const observe = observer(converged());

    const result = await applyAccessPolicy(plan, { apply: apply.client, observe: observe.client });

    assert.deepEqual(apply.calls, ["stage", "commit"]);
    assert.equal(observe.callCount(), 1, "the guest must be observed before committing");
    assert.equal(result.committed, true);
    assert.equal(result.revision, plan.access.revision);
});

test("observation happens between staging and committing, never after", async () => {
    const order: string[] = [];
    const apply: AccessApplyClient = {
        async stage() { order.push("stage"); return stageResponse(); },
        async commit(transactionId) { order.push("commit"); return commitResponse(transactionId); },
        async rollback() { order.push("rollback"); return {}; },
    };
    const observe = {
        async observe() { order.push("observe"); return converged(); },
    };

    await applyAccessPolicy(plan, { apply, observe });

    assert.deepEqual(order, ["stage", "observe", "commit"]);
});

test("does not commit when a published service port stopped listening", async () => {
    // Guacamole is the student access path; a loaded ruleset that silently
    // stopped serving is worse than a failed apply.
    const apply = recordingApplyClient({
        stage: {
            verification: {
                observed_revision: plan.access.revision,
                revision_matches: true,
                service_ports_listening: ["8080"],
                converged: false,
            },
        },
    });
    const observe = observer(converged());

    const error = await applyAccessPolicy(plan, { apply: apply.client, observe: observe.client })
        .then(() => null, (caught: AccessApplyError) => caught);

    assert.ok(error instanceof AccessApplyError);
    assert.equal(error.stage, "stage");
    assert.match(error.message, /service port\(s\) not listening: 9443/);
    assert.deepEqual(apply.calls, ["stage", "rollback"]);
    assert.equal(observe.callCount(), 0, "no point observing a stage that already failed");
});

test("does not commit when the guest loaded a ruleset it cannot name", async () => {
    const apply = recordingApplyClient({
        stage: {
            verification: {
                observed_revision: null,
                revision_matches: false,
                service_ports_listening: ["8080", "9443"],
                converged: false,
            },
        },
    });
    const observe = observer(converged());

    const error = await applyAccessPolicy(plan, { apply: apply.client, observe: observe.client })
        .then(() => null, (caught: AccessApplyError) => caught);

    assert.ok(error instanceof AccessApplyError);
    assert.match(error.message, /guest reports revision none/);
    assert.ok(!apply.calls.includes("commit"));
});

test("does not commit when the independent observation still reports drift", async () => {
    // The applier can report success while the guest disagrees, which is exactly
    // why the observation is a separate channel rather than a second read here.
    const apply = recordingApplyClient();
    const observe = observer(observation("b".repeat(64)));

    const error = await applyAccessPolicy(plan, { apply: apply.client, observe: observe.client })
        .then(() => null, (caught: AccessApplyError) => caught);

    assert.ok(error instanceof AccessApplyError);
    assert.equal(error.stage, "verify");
    assert.match(error.message, /access-guest-nftables-revision/);
    assert.deepEqual(apply.calls, ["stage", "rollback"]);
});

test("does not commit when the guest's Docker bridges moved under the apply", async () => {
    // Desired state names the Docker CIDRs, so a bridge that appeared mid-apply
    // means the staged ruleset no longer describes this guest.
    const apply = recordingApplyClient();
    const observe = observer(converged((root) => {
        root.guest.docker_bridge_cidrs = [...DOCKER_BRIDGE_CIDRS, "172.19.0.0/16"];
    }));

    const error = await applyAccessPolicy(plan, { apply: apply.client, observe: observe.client })
        .then(() => null, (caught: AccessApplyError) => caught);

    assert.ok(error instanceof AccessApplyError);
    assert.equal(error.stage, "verify");
    assert.deepEqual(apply.calls, ["stage", "rollback"]);
});

test("does not commit when the guest cannot be observed at all", async () => {
    const apply = recordingApplyClient();
    const observe = observer(null, new Error("Restricted SSH execution timed out"));

    const error = await applyAccessPolicy(plan, { apply: apply.client, observe: observe.client })
        .then(() => null, (caught: AccessApplyError) => caught);

    assert.ok(error instanceof AccessApplyError);
    assert.equal(error.stage, "verify");
    assert.match(error.message, /could not be observed/);
    assert.deepEqual(apply.calls, ["stage", "rollback"]);
});

test("refuses to proceed when the guest staged without an armed rollback timer", async () => {
    const apply = recordingApplyClient({ stage: { rollback_armed: false } });
    const observe = observer(converged());

    const error = await applyAccessPolicy(plan, { apply: apply.client, observe: observe.client })
        .then(() => null, (caught: AccessApplyError) => caught);

    assert.ok(error instanceof AccessApplyError);
    assert.match(error.message, /without an armed rollback timer/);
    assert.ok(!apply.calls.includes("commit"));
});

test("refuses to commit a transaction that staged a different revision", async () => {
    const apply = recordingApplyClient({ stage: { revision: "c".repeat(64) } });
    const observe = observer(converged());

    const error = await applyAccessPolicy(plan, { apply: apply.client, observe: observe.client })
        .then(() => null, (caught: AccessApplyError) => caught);

    assert.ok(error instanceof AccessApplyError);
    assert.match(error.message, /staged revision/);
    assert.ok(!apply.calls.includes("commit"));
});

test("a failed rollback is recorded but never masks the original failure", async () => {
    // The timer on the guest is still the guarantee, so the useful information
    // is why the apply failed, not that the shortcut recovery also failed.
    const apply = recordingApplyClient({
        stage: {
            verification: {
                observed_revision: null,
                revision_matches: false,
                service_ports_listening: [],
                converged: false,
            },
        },
        rollbackError: new Error("pct exec channel unreachable"),
    });
    const observe = observer(converged());

    const error = await applyAccessPolicy(plan, { apply: apply.client, observe: observe.client })
        .then(() => null, (caught: AccessApplyError) => caught);

    assert.ok(error instanceof AccessApplyError);
    assert.match(error.message, /service port\(s\) not listening: 8080, 9443/);
    assert.equal(error.rolledBack, false);
});

test("records a successful immediate rollback on the error", async () => {
    const apply = recordingApplyClient({ stage: { rollback_armed: false } });
    const observe = observer(converged());

    const error = await applyAccessPolicy(plan, { apply: apply.client, observe: observe.client })
        .then(() => null, (caught: AccessApplyError) => caught);

    assert.equal((error as AccessApplyError).rolledBack, true);
});

test("treats a commit that leaves the timer armed as a failure", async () => {
    const apply = recordingApplyClient({ commitRollbackArmed: true });
    const observe = observer(converged());

    const error = await applyAccessPolicy(plan, { apply: apply.client, observe: observe.client })
        .then(() => null, (caught: AccessApplyError) => caught);

    assert.ok(error instanceof AccessApplyError);
    assert.equal(error.stage, "commit");
    assert.match(error.message, /rollback timer is still armed/);
});

test("an advisory check nobody triggered does not veto the commit", async () => {
    // The per-port source checks are "unobserved" whenever no student happens to
    // be connected, which must not be read as drift.
    const apply = recordingApplyClient();
    const observed = converged();
    const advisory = planAccess(infrastructurePlan, observed).checks
        .filter(({ key }) => key.endsWith("-source"));

    await applyAccessPolicy(plan, { apply: apply.client, observe: observer(observed).client });

    assert.ok(advisory.length > 0);
    assert.ok(advisory.every(({ status, required }) => status === "unobserved" && !required));
    assert.deepEqual(apply.calls, ["stage", "commit"]);
});

test("stages exactly the rendered files for the plan", async () => {
    let staged: Record<string, string> = {};
    const apply: AccessApplyClient = {
        async stage(input) { staged = input.files; return stageResponse(); },
        async commit(transactionId) { return commitResponse(transactionId); },
        async rollback() { return {}; },
    };

    await applyAccessPolicy(plan, { apply, observe: observer(converged()).client });

    assert.deepEqual(Object.keys(staged).sort(), Object.keys(renderedAccessFiles(plan.access)).sort());
    assert.ok(staged["/etc/nftables.d/virtual-lab-access.nft"].includes(plan.access.revision));
    assert.ok(staged["/etc/systemd/network/50-eth1.2002.netdev"].includes("Id=2002"));
    assert.ok(staged["/etc/sysctl.d/99-virtual-lab-access.conf"].includes("net.ipv4.ip_forward = 1"));
});

test("the staged revision is the one the observation channel checks for", async () => {
    // The applier and `planAccess` derive desired state independently. If they
    // ever disagreed, every apply would stage a revision the proof rejects.
    const failing = planAccess(infrastructurePlan, converged()).checks
        .filter((check) => check.required && check.status !== "pass");

    assert.deepEqual(failing, []);
});

test("the SSH client sends a well-formed stage request and validates the answer", async () => {
    let sent: Record<string, unknown> = {};
    const client = new RestrictedSshAccessApplyClient({
        execute: async (request) => {
            sent = request as Record<string, unknown>;
            return stageResponse({ request_id: String(sent.request_id) });
        },
    });

    await client.stage({
        revision: plan.access.revision,
        files: { "/etc/nftables.d/virtual-lab-access.nft": "x" },
        rollbackSeconds: 120,
    });

    assert.equal(sent.version, 1);
    assert.equal(sent.target, "access");
    assert.equal(sent.operation, "stage");
    assert.equal(sent.revision, plan.access.revision);
    assert.equal(sent.rollback_seconds, 120);
    assert.match(String(sent.request_id), /^[0-9a-f-]{36}$/);
});

test("the SSH client rejects a malformed stage answer instead of trusting it", async () => {
    const client = new RestrictedSshAccessApplyClient({
        execute: async () => ({ version: 1, target: "access", operation: "stage" }),
    });

    await assert.rejects(() => client.stage({
        revision: "d".repeat(64),
        files: { "/etc/nftables.d/virtual-lab-access.nft": "x" },
        rollbackSeconds: 120,
    }));
});

test("the SSH client rejects an answer that belongs to a different request", async () => {
    // A well-formed commit response is still worthless if it answers some other
    // request: it could be describing an earlier transaction entirely.
    const client = new RestrictedSshAccessApplyClient({
        execute: async () => commitResponse("ax-20260812T000000Z"),
    });

    await assert.rejects(
        () => client.commit("ax-20260812T000000Z"),
        /request ID does not match/,
    );
});
