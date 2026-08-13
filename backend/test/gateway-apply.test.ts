import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
    buildGatewayPlan,
    GatewayDesiredStateInput,
    GatewayPlan,
} from "../src/network/gateway-desired-state";
import { renderedGatewayFiles } from "../src/network/adapters/gateway";
import {
    applyGatewayPolicy,
    GatewayApplyClient,
    GatewayApplyError,
    GatewayStageResponse,
    RestrictedSshGatewayApplyClient,
} from "../src/network/gateway-apply";
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

function convergedObservation(plan: GatewayPlan): Record<string, unknown> {
    const desired = plan.desired_state;
    const files = renderedGatewayFiles(plan);
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
            net1: { bridge: "vmbr20", firewall: true, connected: true, trunks: APPROVED_VLANS },
            net2: { bridge: "vmbr0", firewall: true, connected: true, trunks: [] },
        },
        ip_config: { ipconfig0: "ip=10.10.10.2/24" },
        guest: {
            version: 1,
            captured_at: "2026-08-12T00:00:00Z",
            interfaces: [
                { name: "eth0", addresses: ["10.10.10.2/24"], parent: null, operstate: "UP" },
                { name: "eth2", addresses: ["172.16.0.36/22"], parent: null, operstate: "UP" },
                { name: "ens19", addresses: [], parent: null, operstate: "DOWN" },
                ...desired.transport.interfaces.map(({ interface_name, gateway_ip, subnet_cidr }) => ({
                    name: interface_name,
                    addresses: [`${gateway_ip}/${subnet_cidr.split("/")[1]}`],
                    parent: desired.transport.parent_interface,
                    operstate: "UP",
                })),
            ],
            vlan_interfaces: desired.transport.interfaces.map(({ interface_name, vlan_tag }) => ({
                name: interface_name,
                vlan_id: vlan_tag,
                parent: desired.transport.parent_interface,
            })),
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
}

function stageResponse(
    plan: GatewayPlan,
    overrides: Partial<GatewayStageResponse> = {},
): GatewayStageResponse {
    return {
        version: 1,
        request_id: "00000000-0000-4000-8000-000000000001",
        target: "gateway",
        operation: "stage",
        transaction_id: "gw-20260812T000000Z",
        revision: plan.revision,
        validators: ["nft -c", "squid -k parse", "dnsmasq --test"],
        pruned: [],
        reloaded: ["sysctl", "dnsmasq", "squid", "nftables"],
        verification: {
            services_inactive: [],
            observed_revision: plan.revision,
            revision_matches: true,
            converged: true,
        },
        rollback_armed: true,
        rollback_seconds: 300,
        ...overrides,
    } as GatewayStageResponse;
}

type Recorder = {
    client: GatewayApplyClient;
    calls: string[];
};

function recordingApplyClient(
    plan: GatewayPlan,
    options: {
        stage?: Partial<GatewayStageResponse>;
        stageError?: Error;
        commitRollbackArmed?: boolean;
        commitError?: Error;
        rollbackError?: Error;
    } = {},
): Recorder {
    const calls: string[] = [];
    return {
        calls,
        client: {
            async stage() {
                calls.push("stage");
                if (options.stageError) throw options.stageError;
                return stageResponse(plan, options.stage);
            },
            async commit(transactionId) {
                calls.push("commit");
                if (options.commitError) throw options.commitError;
                return {
                    version: 1,
                    request_id: "00000000-0000-4000-8000-000000000002",
                    target: "gateway",
                    operation: "commit",
                    transaction_id: transactionId,
                    revision: plan.revision,
                    committed: true,
                    rollback_armed: options.commitRollbackArmed ?? false,
                    verification: {
                        services_inactive: [],
                        observed_revision: plan.revision,
                        revision_matches: true,
                        converged: true,
                    },
                } as never;
            },
            async rollback() {
                calls.push("rollback");
                if (options.rollbackError) throw options.rollbackError;
                return {};
            },
        },
    };
}

function observer(observation: unknown, error?: Error) {
    let calls = 0;
    return {
        client: {
            async observe() {
                calls += 1;
                if (error) throw error;
                return observation as never;
            },
        },
        callCount: () => calls,
    };
}

test("commits only after an independent observation agrees the guest converged", async () => {
    const plan = buildGatewayPlan(baseInput());
    const apply = recordingApplyClient(plan);
    const observe = observer(convergedObservation(plan));

    const result = await applyGatewayPolicy(plan, { apply: apply.client, observe: observe.client });

    assert.deepEqual(apply.calls, ["stage", "commit"]);
    assert.equal(observe.callCount(), 1, "the guest must be observed before committing");
    assert.equal(result.committed, true);
    assert.equal(result.revision, plan.revision);
});

test("observation happens between staging and committing, never after", async () => {
    const plan = buildGatewayPlan(baseInput());
    const order: string[] = [];
    const apply: GatewayApplyClient = {
        async stage() { order.push("stage"); return stageResponse(plan); },
        async commit(id) {
            order.push("commit");
            return {
                version: 1, request_id: "00000000-0000-4000-8000-000000000002", target: "gateway",
                operation: "commit", transaction_id: id, revision: plan.revision, committed: true,
                rollback_armed: false,
                verification: { services_inactive: [], observed_revision: plan.revision, revision_matches: true, converged: true },
            } as never;
        },
        async rollback() { order.push("rollback"); return {}; },
    };
    const observe = {
        async observe() { order.push("observe"); return convergedObservation(plan) as never; },
    };

    await applyGatewayPolicy(plan, { apply, observe });

    assert.deepEqual(order, ["stage", "observe", "commit"]);
});

test("does not commit when the guest reports an inactive service", async () => {
    const plan = buildGatewayPlan(baseInput());
    const apply = recordingApplyClient(plan, {
        stage: {
            verification: {
                services_inactive: ["squid"],
                observed_revision: plan.revision,
                revision_matches: true,
                converged: false,
            },
        },
    });
    const observe = observer(convergedObservation(plan));

    const error = await applyGatewayPolicy(plan, { apply: apply.client, observe: observe.client })
        .then(() => null, (caught: GatewayApplyError) => caught);

    assert.ok(error instanceof GatewayApplyError);
    assert.equal(error.stage, "stage");
    assert.match(error.message, /inactive service\(s\): squid/);
    assert.ok(!apply.calls.includes("commit"), "must not commit a non-converged transaction");
    assert.deepEqual(apply.calls, ["stage", "rollback"]);
    assert.equal(observe.callCount(), 0, "no point observing a stage that already failed");
});

test("does not commit when the independent observation still reports drift", async () => {
    // The applier can report success while the guest disagrees, which is exactly
    // why the observation is a separate channel rather than a second read here.
    const plan = buildGatewayPlan(baseInput());
    const apply = recordingApplyClient(plan);
    const drifted = convergedObservation(plan);
    (drifted.guest as Record<string, unknown>).nftables_revision = "b".repeat(64);
    const observe = observer(drifted);

    const error = await applyGatewayPolicy(plan, { apply: apply.client, observe: observe.client })
        .then(() => null, (caught: GatewayApplyError) => caught);

    assert.ok(error instanceof GatewayApplyError);
    assert.equal(error.stage, "verify");
    assert.match(error.message, /gateway-nftables-revision/);
    assert.deepEqual(apply.calls, ["stage", "rollback"]);
});

test("does not commit when the guest cannot be observed at all", async () => {
    // The lockout case: the ruleset came up and cut off the observer.
    const plan = buildGatewayPlan(baseInput());
    const apply = recordingApplyClient(plan);
    const observe = observer(null, new Error("Restricted SSH execution timed out"));

    const error = await applyGatewayPolicy(plan, { apply: apply.client, observe: observe.client })
        .then(() => null, (caught: GatewayApplyError) => caught);

    assert.ok(error instanceof GatewayApplyError);
    assert.equal(error.stage, "verify");
    assert.match(error.message, /could not be observed/);
    assert.deepEqual(apply.calls, ["stage", "rollback"]);
});

test("refuses to proceed when the guest staged without an armed rollback timer", async () => {
    const plan = buildGatewayPlan(baseInput());
    const apply = recordingApplyClient(plan, { stage: { rollback_armed: false } });
    const observe = observer(convergedObservation(plan));

    const error = await applyGatewayPolicy(plan, { apply: apply.client, observe: observe.client })
        .then(() => null, (caught: GatewayApplyError) => caught);

    assert.ok(error instanceof GatewayApplyError);
    assert.match(error.message, /without an armed rollback timer/);
    assert.ok(!apply.calls.includes("commit"));
});

test("refuses to commit a transaction that staged a different revision", async () => {
    const plan = buildGatewayPlan(baseInput());
    const apply = recordingApplyClient(plan, { stage: { revision: "c".repeat(64) } });
    const observe = observer(convergedObservation(plan));

    const error = await applyGatewayPolicy(plan, { apply: apply.client, observe: observe.client })
        .then(() => null, (caught: GatewayApplyError) => caught);

    assert.ok(error instanceof GatewayApplyError);
    assert.match(error.message, /staged revision/);
    assert.ok(!apply.calls.includes("commit"));
});

test("a failed rollback is recorded but never masks the original failure", async () => {
    // The timer on the guest is still the guarantee, so the useful information
    // is why the apply failed, not that the shortcut recovery also failed.
    const plan = buildGatewayPlan(baseInput());
    const apply = recordingApplyClient(plan, {
        stage: {
            verification: {
                services_inactive: ["dnsmasq"],
                observed_revision: null,
                revision_matches: false,
                converged: false,
            },
        },
        rollbackError: new Error("rollback channel unreachable"),
    });
    const observe = observer(convergedObservation(plan));

    const error = await applyGatewayPolicy(plan, { apply: apply.client, observe: observe.client })
        .then(() => null, (caught: GatewayApplyError) => caught);

    assert.ok(error instanceof GatewayApplyError);
    assert.match(error.message, /inactive service\(s\): dnsmasq/);
    assert.equal(error.rolledBack, false);
});

test("records a successful immediate rollback on the error", async () => {
    const plan = buildGatewayPlan(baseInput());
    const apply = recordingApplyClient(plan, { stage: { rollback_armed: false } });
    const observe = observer(convergedObservation(plan));

    const error = await applyGatewayPolicy(plan, { apply: apply.client, observe: observe.client })
        .then(() => null, (caught: GatewayApplyError) => caught);

    assert.equal((error as GatewayApplyError).rolledBack, true);
});

test("treats a commit that leaves the timer armed as a failure", async () => {
    const plan = buildGatewayPlan(baseInput());
    const apply = recordingApplyClient(plan, { commitRollbackArmed: true });
    const observe = observer(convergedObservation(plan));

    const error = await applyGatewayPolicy(plan, { apply: apply.client, observe: observe.client })
        .then(() => null, (caught: GatewayApplyError) => caught);

    assert.ok(error instanceof GatewayApplyError);
    assert.equal(error.stage, "commit");
    assert.match(error.message, /rollback timer is still armed/);
});

test("stages exactly the rendered files for the plan", async () => {
    const plan = buildGatewayPlan(baseInput({
        groups: [{
            group_id: 1,
            vlan_tag: 2000,
            subnet_cidr: "10.200.0.0/24",
            allowed_web_domains: [{ domain: "archive.ubuntu.com", include_subdomains: false }],
        }],
    }));
    let staged: Record<string, string> = {};
    const apply: GatewayApplyClient = {
        async stage(input) { staged = input.files; return stageResponse(plan); },
        async commit(id) {
            return {
                version: 1, request_id: "00000000-0000-4000-8000-000000000002", target: "gateway",
                operation: "commit", transaction_id: id, revision: plan.revision, committed: true,
                rollback_armed: false,
                verification: { services_inactive: [], observed_revision: plan.revision, revision_matches: true, converged: true },
            } as never;
        },
        async rollback() { return {}; },
    };

    await applyGatewayPolicy(plan, { apply, observe: observer(convergedObservation(plan)).client });

    assert.deepEqual(Object.keys(staged).sort(), Object.keys(renderedGatewayFiles(plan)).sort());
    assert.ok(staged["/etc/squid/squid.conf"].includes("archive.ubuntu.com"));
});

test("the SSH client sends a well-formed stage request and validates the answer", async () => {
    const plan = buildGatewayPlan(baseInput());
    let sent: Record<string, unknown> = {};
    const client = new RestrictedSshGatewayApplyClient({
        execute: async (request) => {
            sent = request as Record<string, unknown>;
            return stageResponse(plan);
        },
    });

    await client.stage({ revision: plan.revision, files: { "/etc/squid/squid.conf": "x" }, rollbackSeconds: 120 });

    assert.equal(sent.version, 1);
    assert.equal(sent.target, "gateway");
    assert.equal(sent.operation, "stage");
    assert.equal(sent.revision, plan.revision);
    assert.equal(sent.rollback_seconds, 120);
    assert.match(String(sent.request_id), /^[0-9a-f-]{36}$/);
});

test("the SSH client rejects a malformed stage answer instead of trusting it", async () => {
    const client = new RestrictedSshGatewayApplyClient({
        execute: async () => ({ version: 1, target: "gateway", operation: "stage" }),
    });

    await assert.rejects(() => client.stage({
        revision: "d".repeat(64),
        files: { "/etc/squid/squid.conf": "x" },
        rollbackSeconds: 120,
    }));
});
