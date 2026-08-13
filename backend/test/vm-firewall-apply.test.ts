import assert from "node:assert/strict";
import test from "node:test";
import {
    observeVmFirewall,
    planVmFirewall,
} from "../src/network/adapters/proxmox-vm-firewall";
import { applyVmFirewall, VmFirewallApplyError } from "../src/network/vm-firewall-apply";
import { buildVmFirewallPolicy, VM_FIREWALL_IPSET } from "../src/network/vm-firewall";
import { ProxmoxFirewallRule } from "../src/proxmox/types";

const policy = buildVmFirewallPolicy({
    vmid: "10000",
    subnet_cidr: "10.200.0.0/24",
    gateway_ip: "10.200.0.1",
    access_ip: "10.200.0.2",
    session_ports: [3389],
    peer_subnet_cidrs: [],
});

/**
 * A Proxmox stand-in that keeps the state the real API keeps: positional rules
 * that renumber on delete, a guest-scoped IPSet namespace, and options reported
 * as 0/1.
 */
function fakeProxmox(initial: {
    options?: Record<string, unknown>;
    rules?: ProxmoxFirewallRule[];
    ipset?: { cidr: string; nomatch?: number }[] | null;
} = {}) {
    let options: Record<string, unknown> = { ...(initial.options ?? {}) };
    let rules: ProxmoxFirewallRule[] = [...(initial.rules ?? [])];
    let ipset = initial.ipset === undefined ? null : initial.ipset;
    const calls: string[] = [];
    const renumber = () => rules.forEach((rule, index) => { rule.pos = index; });

    return {
        calls,
        state: () => ({ options, rules, ipset }),
        async getVmFirewallOptions() { return options; },
        async getVmFirewallRules() { return rules.map((rule) => ({ ...rule })); },
        async getVmFirewallIpSets() {
            return ipset === null ? [] : [{ name: VM_FIREWALL_IPSET }];
        },
        async getVmFirewallIpSetEntries() {
            if (ipset === null) throw new Error("ipset does not exist");
            return ipset.map((entry) => ({ ...entry }));
        },
        async updateVmFirewallOptions(_vmid: string, input: Record<string, unknown>) {
            calls.push("options");
            options = Object.fromEntries(Object.entries(input).map(([key, value]) => [
                key,
                typeof value === "boolean" ? (value ? 1 : 0) : value,
            ]));
        },
        async createVmFirewallRule(_vmid: string, rule: any) {
            calls.push(`rule+${rule.type}:${rule.dport ?? rule.sport ?? rule.dest ?? rule.proto ?? "any"}`);
            // A POST without an explicit position inserts at the top, which is
            // what makes the applier write its list in reverse.
            rules.unshift({ ...rule, pos: 0, enable: rule.enable === false ? 0 : 1 });
            renumber();
        },
        async deleteVmFirewallRule(_vmid: string, position: number) {
            calls.push(`rule-${position}`);
            rules.splice(position, 1);
            renumber();
        },
        async createVmFirewallIpSet() { calls.push("ipset+"); ipset = []; },
        async createVmFirewallIpSetEntry(_vmid: string, _name: string, entry: any) {
            calls.push(`entry+${entry.cidr}`);
            (ipset ??= []).push({ cidr: entry.cidr, nomatch: entry.nomatch ? 1 : 0 });
        },
        async deleteVmFirewallIpSetEntry(_vmid: string, _name: string, cidr: string) {
            calls.push(`entry-${cidr}`);
            ipset = (ipset ?? []).filter((entry) => entry.cidr !== cidr);
        },
    };
}

test("an unconfigured VM is brought fully into policy and verified", async () => {
    const proxmox = fakeProxmox();
    const result = await applyVmFirewall(policy, proxmox as never);

    assert.equal(result.changed, true);
    assert.equal(result.revision, policy.revision);
    const plan = planVmFirewall(policy, await observeVmFirewall(proxmox as never, "10000"));
    assert.ok(plan.no_change_required, plan.checks.map((c) => c.detail).join("; "));
});

test("rules land in the intended evaluation order", async () => {
    // Proxmox stops at the first match, so the same rules in a different order
    // can mean something else entirely.
    const proxmox = fakeProxmox();
    await applyVmFirewall(policy, proxmox as never);

    assert.deepEqual(
        proxmox.state().rules.map((rule) => `${rule.type}:${rule.action}`),
        policy.rules.map((rule) => `${rule.type}:${rule.action}`),
    );
});

test("the source filter is written before the ingress rules", async () => {
    // Both orders converge, but only this one is safe if the process dies in
    // between: a VM that can send only from its own address while its ingress is
    // still open beats one whose ingress is closed while it can claim any
    // address on the segment.
    const proxmox = fakeProxmox();
    await applyVmFirewall(policy, proxmox as never);

    const firstEntry = proxmox.calls.findIndex((call) => call.startsWith("entry+"));
    const firstRule = proxmox.calls.findIndex((call) => call.startsWith("rule+"));
    assert.ok(firstEntry >= 0 && firstRule >= 0);
    assert.ok(firstEntry < firstRule);
});

test("enabling the firewall is the last write", async () => {
    // Until then the guest firewall is inert, so a half-written ruleset filters
    // nothing rather than filtering wrongly.
    const proxmox = fakeProxmox();
    await applyVmFirewall(policy, proxmox as never);

    assert.equal(proxmox.calls[proxmox.calls.length - 1], "options");
});

test("pre-existing rules are cleared from the highest position down", async () => {
    // Proxmox renumbers on every delete, so ascending order skips every second
    // rule and leaves a partial ruleset behind.
    const proxmox = fakeProxmox({
        rules: [
            { pos: 0, type: "in", action: "ACCEPT", proto: "tcp", dport: "23" },
            { pos: 1, type: "in", action: "ACCEPT", proto: "tcp", dport: "445" },
            { pos: 2, type: "in", action: "ACCEPT", proto: "tcp", dport: "3389" },
        ],
    });
    await applyVmFirewall(policy, proxmox as never);

    const deletions = proxmox.calls.filter((call) => call.startsWith("rule-"));
    assert.deepEqual(deletions, ["rule-2", "rule-1", "rule-0"]);
    assert.ok(!proxmox.state().rules.some((rule) => rule.dport === "445"));
});

test("an entry with the wrong nomatch is replaced, not left in place", async () => {
    // A stale nomatch on the subnet entry would deny every address instead of
    // two, which reads as "configured" while blocking the whole VM.
    const proxmox = fakeProxmox({
        ipset: [{ cidr: "10.200.0.0/24", nomatch: 1 }],
    });
    await applyVmFirewall(policy, proxmox as never);

    assert.deepEqual(
        proxmox.state().ipset,
        [
            { cidr: "10.200.0.0/24", nomatch: 0 },
            { cidr: "10.200.0.1", nomatch: 1 },
            { cidr: "10.200.0.2", nomatch: 1 },
        ],
    );
});

test("a Proxmox-normalised host entry is not mistaken for drift", async () => {
    // Proxmox drops the /32 from a single address. Comparing literally would
    // report permanent drift on a converged VM and rewrite it on every apply.
    const proxmox = fakeProxmox();
    await applyVmFirewall(policy, proxmox as never);
    const observation = await observeVmFirewall(proxmox as never, "10000");
    const suffixed = observation.ipset!.map((entry) => (
        entry.cidr.includes("/") ? entry : { ...entry, cidr: `${entry.cidr}/32` }
    ));

    assert.ok(planVmFirewall(policy, { ...observation, ipset: suffixed }).no_change_required);
});

test("entries that are no longer desired are removed", async () => {
    const proxmox = fakeProxmox({ ipset: [{ cidr: "10.200.9.0/24", nomatch: 0 }] });
    await applyVmFirewall(policy, proxmox as never);

    assert.ok(!proxmox.state().ipset?.some((entry) => entry.cidr === "10.200.9.0/24"));
});

test("an already-converged VM is not rewritten", async () => {
    const proxmox = fakeProxmox();
    await applyVmFirewall(policy, proxmox as never);
    proxmox.calls.length = 0;

    const result = await applyVmFirewall(policy, proxmox as never);
    assert.equal(result.changed, false);
    assert.deepEqual(proxmox.calls, []);
});

test("a VM that does not converge fails rather than reporting success", async () => {
    const proxmox = fakeProxmox();
    // Silently drop the options write, which is how `enable` would stay unset.
    proxmox.updateVmFirewallOptions = async () => {};

    await assert.rejects(
        () => applyVmFirewall(policy, proxmox as never),
        (error: VmFirewallApplyError) => error.stage === "verify",
    );
});

test("a missing ipfilter set is drift, not an empty one", async () => {
    // An empty set drops every packet the VM sends, so the two states must never
    // be reported the same way.
    const proxmox = fakeProxmox();
    await applyVmFirewall(policy, proxmox as never);
    const observation = await observeVmFirewall(proxmox as never, "10000");

    assert.ok(observation.ipset !== null);
    const missing = planVmFirewall(policy, { ...observation, ipset: null });
    assert.equal(missing.no_change_required, false);
    assert.match(
        missing.checks.find((check) => check.key.startsWith("vm-firewall-ipfilter"))!.detail,
        /absent, so ipfilter would drop every packet/,
    );
});

test("an unset option is drift rather than a default", async () => {
    // Defaulting would let a VM that was never configured read as configured.
    const plan = planVmFirewall(policy, {
        vmid: "10000",
        options: { policy_in: "DROP", policy_out: "ACCEPT" },
        rules: [...policy.rules].map((rule, pos) => ({ ...rule, pos, enable: 1 })) as never,
        ipset: policy.ipset.map(({ cidr, nomatch }) => ({ cidr, nomatch: nomatch ? 1 : 0 })),
    });

    assert.equal(plan.no_change_required, false);
    assert.match(
        plan.checks.find((check) => check.key.startsWith("vm-firewall-options"))!.detail,
        /enable=unset/,
    );
});

test("reordered rules are drift even when every rule is present", async () => {
    const proxmox = fakeProxmox();
    await applyVmFirewall(policy, proxmox as never);
    const observation = await observeVmFirewall(proxmox as never, "10000");
    const swapped = [...observation.rules];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];

    assert.equal(planVmFirewall(policy, { ...observation, rules: swapped }).no_change_required, false);
});

test("an observation for another VM is refused outright", () => {
    assert.throws(
        () => planVmFirewall(policy, {
            vmid: "10001",
            options: {},
            rules: [],
            ipset: null,
        }),
        /observation is for 10001/,
    );
});
