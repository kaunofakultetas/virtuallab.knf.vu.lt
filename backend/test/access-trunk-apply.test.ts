import assert from "node:assert/strict";
import test from "node:test";
import {
    accessTrunkDrift,
    applyAccessTrunk,
    AccessTrunkApplyClient,
    AccessTrunkApplyError,
    AccessTrunkApplyResponse,
    AccessTrunkCommitResponse,
    AccessTrunkObserveResponse,
    RestrictedSshAccessTrunkApplyClient,
} from "../src/network/access-trunk-apply";
import { planAccessTrunk } from "../src/network/access-trunk";
import { AccessHostObservation, AccessObservationClient } from "../src/network/adapters/access";

const NET1 = "name=eth1,bridge=vmbr20,host-managed=0,hwaddr=BC:24:11:60:E1:F1,trunks=2000,type=veth";

function trunkPlan(desired: number[], observed: { persistent: number[]; live: number[]; veth?: boolean }) {
    return planAccessTrunk({
        desired_vlan_ids: desired,
        observed: {
            persistent_vlan_ids: observed.persistent,
            live_veth_present: observed.veth ?? true,
            live_vlan_ids: observed.live,
        },
    });
}

function hostObservation(
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

function observer(observation: AccessHostObservation | (() => never)): AccessObservationClient {
    return {
        async observe() {
            if (typeof observation === "function") return observation();
            return observation;
        },
    };
}

type ClientOptions = {
    desired?: number[];
    converged?: boolean;
    rollbackArmed?: boolean;
    commitRollbackArmed?: boolean;
    onRollback?: () => Promise<unknown>;
};

function trunkClient(options: ClientOptions = {}) {
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
            calls.push(`apply:${input.desiredVlanIds.join("-")}:${input.expectedNet1}`);
            const desired = options.desired ?? input.desiredVlanIds;
            return {
                version: 1,
                request_id: "00000000-0000-4000-8000-000000000002",
                target: "access-trunk",
                operation: "apply",
                captured_at: "2026-08-12T00:00:00Z",
                transaction_id: "tr-test",
                desired_vlan_ids: desired,
                persistent_changed: true,
                added: [2002],
                removed: [],
                observed: {
                    net1: NET1,
                    persistent_vlan_ids: desired,
                    live_veth_present: true,
                    live_vlan_ids: desired,
                },
                converged: options.converged ?? true,
                rollback_armed: options.rollbackArmed ?? true,
                rollback_seconds: 300,
            };
        },
        async commit(transactionId): Promise<AccessTrunkCommitResponse> {
            calls.push(`commit:${transactionId}`);
            return {
                version: 1,
                request_id: "00000000-0000-4000-8000-000000000003",
                target: "access-trunk",
                operation: "commit",
                captured_at: "2026-08-12T00:00:00Z",
                transaction_id: transactionId,
                committed: true,
                rollback_armed: options.commitRollbackArmed ?? false,
                observed: {
                    net1: NET1,
                    persistent_vlan_ids: [2000, 2002],
                    live_veth_present: true,
                    live_vlan_ids: [2000, 2002],
                },
            };
        },
        async rollback(transactionId) {
            calls.push(`rollback:${transactionId}`);
            return options.onRollback ? options.onRollback() : { rolled_back: true };
        },
    };
    return { client, calls };
}

test("a converged trunk stages nothing and arms no rollback timer", async () => {
    // Arming a timer for a no-op would put the container's transport on a
    // dead-man's switch for no reason at all.
    const { client, calls } = trunkClient();
    const result = await applyAccessTrunk(
        trunkPlan([2000, 2002], { persistent: [2000, 2002], live: [2000, 2002] }),
        { apply: client, observe: observer(hostObservation([2000, 2002], [2000, 2002])) },
    );
    assert.equal(result.changed, false);
    assert.equal(result.transaction_id, null);
    assert.deepEqual(calls, []);
});

test("a drifted trunk is applied, proved through the observer, then committed", async () => {
    const { client, calls } = trunkClient();
    const result = await applyAccessTrunk(
        trunkPlan([2000, 2002], { persistent: [2000], live: [2000] }),
        { apply: client, observe: observer(hostObservation([2000, 2002], [2000, 2002])) },
    );
    assert.equal(result.changed, true);
    assert.equal(result.transaction_id, "tr-test");
    assert.deepEqual(calls, [
        "observe",
        `apply:2000-2002:${NET1}`,
        "commit:tr-test",
    ]);
});

test("the observed net1 line is handed back as an apply precondition", async () => {
    // Optimistic concurrency on the mutating channel: if anything rewrote net1
    // between the read and the write, the host refuses rather than clobbering.
    const { client, calls } = trunkClient();
    await applyAccessTrunk(
        trunkPlan([2000, 2002], { persistent: [2000], live: [2000] }),
        { apply: client, observe: observer(hostObservation([2000, 2002], [2000, 2002])) },
    );
    assert.ok(calls.some((call) => call.endsWith(NET1)));
});

test("an absent host veth is refused before anything is staged", async () => {
    const { client, calls } = trunkClient();
    await assert.rejects(
        () => applyAccessTrunk(
            trunkPlan([2000, 2002], { persistent: [2000], live: [], veth: false }),
            { apply: client, observe: observer(hostObservation([2000], [], false)) },
        ),
        (error: AccessTrunkApplyError) => error.stage === "observe",
    );
    assert.deepEqual(calls, []);
});

test("a host that applied a different VLAN list is rolled back, never committed", async () => {
    const { client, calls } = trunkClient({ desired: [2000] });
    await assert.rejects(
        () => applyAccessTrunk(
            trunkPlan([2000, 2002], { persistent: [2000], live: [2000] }),
            { apply: client, observe: observer(hostObservation([2000, 2002], [2000, 2002])) },
        ),
        (error: AccessTrunkApplyError) => error.stage === "apply" && error.rolledBack === true,
    );
    assert.ok(calls.includes("rollback:tr-test"));
    assert.ok(!calls.some((call) => call.startsWith("commit")));
});

test("a host that reports no convergence is rolled back", async () => {
    const { client, calls } = trunkClient({ converged: false });
    await assert.rejects(
        () => applyAccessTrunk(
            trunkPlan([2000, 2002], { persistent: [2000], live: [2000] }),
            { apply: client, observe: observer(hostObservation([2000, 2002], [2000, 2002])) },
        ),
        (error: AccessTrunkApplyError) => error.stage === "apply",
    );
    assert.ok(calls.includes("rollback:tr-test"));
});

test("an unarmed rollback timer refuses to proceed", async () => {
    // Without the timer there is no recovery if the next step cannot reach the
    // host, so this session's reachability would become the only safety net.
    const { client, calls } = trunkClient({ rollbackArmed: false });
    await assert.rejects(
        () => applyAccessTrunk(
            trunkPlan([2000, 2002], { persistent: [2000], live: [2000] }),
            { apply: client, observe: observer(hostObservation([2000, 2002], [2000, 2002])) },
        ),
        (error: AccessTrunkApplyError) => error.stage === "apply",
    );
    assert.ok(!calls.some((call) => call.startsWith("commit")));
});

test("a persistent-only convergence is caught by the independent observation", async () => {
    // The host claimed both halves converged; the observer sees the running veth
    // still carrying the old membership. Trusting the applier's own report is
    // exactly what the second channel exists to avoid.
    const { client, calls } = trunkClient();
    await assert.rejects(
        () => applyAccessTrunk(
            trunkPlan([2000, 2002], { persistent: [2000], live: [2000] }),
            { apply: client, observe: observer(hostObservation([2000, 2002], [2000])) },
        ),
        (error: AccessTrunkApplyError) => error.stage === "verify",
    );
    assert.ok(calls.includes("rollback:tr-test"));
    assert.ok(!calls.some((call) => call.startsWith("commit")));
});

test("a live-only convergence is caught too", async () => {
    const { client } = trunkClient();
    await assert.rejects(
        () => applyAccessTrunk(
            trunkPlan([2000, 2002], { persistent: [2000], live: [2000] }),
            { apply: client, observe: observer(hostObservation([2000], [2000, 2002])) },
        ),
        (error: AccessTrunkApplyError) => error.stage === "verify",
    );
});

test("an unreachable observer aborts rather than committing unproven", async () => {
    const { client, calls } = trunkClient();
    await assert.rejects(
        () => applyAccessTrunk(
            trunkPlan([2000, 2002], { persistent: [2000], live: [2000] }),
            {
                apply: client,
                observe: observer(() => { throw new Error("ssh failed"); }),
            },
        ),
        (error: AccessTrunkApplyError) => error.stage === "verify",
    );
    assert.ok(!calls.some((call) => call.startsWith("commit")));
});

test("a failed rollback is recorded on the error without replacing its cause", async () => {
    // The original cause is what an operator needs; the host's timer restores
    // the previous state either way.
    const { client } = trunkClient({
        converged: false,
        onRollback: async () => { throw new Error("rollback channel down"); },
    });
    await assert.rejects(
        () => applyAccessTrunk(
            trunkPlan([2000, 2002], { persistent: [2000], live: [2000] }),
            { apply: client, observe: observer(hostObservation([2000, 2002], [2000, 2002])) },
        ),
        (error: AccessTrunkApplyError) => (
            error.rolledBack === false && error.message.includes("did not converge")
        ),
    );
});

test("a commit that leaves the timer armed is not reported as a settled apply", async () => {
    // The change is correct and proven, but it will be undone minutes from now.
    const { client } = trunkClient({ commitRollbackArmed: true });
    await assert.rejects(
        () => applyAccessTrunk(
            trunkPlan([2000, 2002], { persistent: [2000], live: [2000] }),
            { apply: client, observe: observer(hostObservation([2000, 2002], [2000, 2002])) },
        ),
        (error: AccessTrunkApplyError) => error.stage === "commit",
    );
});

test("drift reporting names both halves independently", () => {
    assert.deepEqual(accessTrunkDrift([2000, 2002], hostObservation([2000, 2002], [2000, 2002])), []);
    assert.equal(accessTrunkDrift([2000, 2002], hostObservation([2000], [2000, 2002])).length, 1);
    assert.equal(accessTrunkDrift([2000, 2002], hostObservation([2000], [2000])).length, 2);
    assert.match(
        accessTrunkDrift([2000], hostObservation([2000], [], false))[0],
        /veth200i1 is absent/,
    );
});

test("ordering differences are not drift", () => {
    // The host returns sorted lists, but nothing in the protocol guarantees it,
    // and a spurious "drift" here would trigger a pointless trunk rewrite.
    assert.deepEqual(accessTrunkDrift([2002, 2000], hostObservation([2000, 2002], [2002, 2000])), []);
});

test("a response whose request ID does not match the request is rejected", async () => {
    // A stale answer left in the channel must never be read as this
    // transaction's result.
    const client = new RestrictedSshAccessTrunkApplyClient({
        async execute() {
            return {
                version: 1,
                request_id: "00000000-0000-4000-8000-00000000dead",
                target: "access-trunk",
                operation: "observe",
                captured_at: "2026-08-12T00:00:00Z",
                net1: NET1,
                persistent_vlan_ids: [2000],
                live_veth_present: true,
                live_vlan_ids: [2000],
            };
        },
    });
    await assert.rejects(() => client.observe(), /request ID does not match/);
});

test("VLAN 1 in a response is a parse failure, not a silently accepted membership", async () => {
    // The host filters the untagged PVID entry out. If it ever stops, a plan
    // proposing `bridge vlan del vid 1` would sever the untagged transport, so
    // the loud failure is the safe outcome.
    const client = new RestrictedSshAccessTrunkApplyClient({
        async execute(request) {
            return {
                version: 1,
                request_id: (request as { request_id: string }).request_id,
                target: "access-trunk",
                operation: "observe",
                captured_at: "2026-08-12T00:00:00Z",
                net1: NET1,
                persistent_vlan_ids: [2000],
                live_veth_present: true,
                live_vlan_ids: [1, 2000],
            };
        },
    });
    await assert.rejects(() => client.observe());
});
