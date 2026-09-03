// -----------------------------------------------------------
//  [*] Tests — the rendered per-VM policy
//
//  Session ports per template, the ordered rule list with
//  its load-bearing DROPs, and the ipfilter IPSet.
//
//  Covers src/network/vm-firewall.ts. Run with `npm test`
//  (the whole suite) inside the backend container.
// -----------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import {
    buildVmFirewallPolicy,
    sessionPortsForTemplate,
    VmFirewallError,
    VmFirewallInput,
    VM_FIREWALL_IPSET,
} from "../src/network/vm-firewall";

function input(overrides: Partial<VmFirewallInput> = {}): VmFirewallInput {
    return {
        vmid: "10000",
        subnet_cidr: "10.200.0.0/24",
        gateway_ip: "10.200.0.1",
        access_ip: "10.200.0.2",
        session_ports: [3389],
        peer_subnet_cidrs: [],
        allow_same_group: false,
        ...overrides,
    };
}

function rulesOf(direction: "in" | "out", policy = buildVmFirewallPolicy(input())) {
    return policy.rules.filter((rule) => rule.type === direction);
}

test("ingress is default-deny and egress is not", () => {
    // Egress policy lives in the Gateway's nftables, which is the single source
    // of truth for what a VM may reach off-segment. Duplicating it here would
    // create two policies that drift.
    const policy = buildVmFirewallPolicy(input());

    assert.equal(policy.options.policy_in, "DROP");
    assert.equal(policy.options.policy_out, "ACCEPT");
    assert.equal(policy.options.enable, true);
});

test("only the Access appliance may open a session, and only on the template's ports", () => {
    const policy = buildVmFirewallPolicy(input({ session_ports: [22] }));
    const session = rulesOf("in", policy).find((rule) => rule.proto === "tcp")!;

    assert.equal(session.action, "ACCEPT");
    assert.equal(session.source, "10.200.0.2");
    assert.equal(session.proto, "tcp");
    assert.equal(session.dport, "22");
});

test("with allow_same_group off, no rule admits another student VM", () => {
    // A source that is neither infrastructure nor a peered subnet must fall
    // through to the DROP policy.
    const policy = buildVmFirewallPolicy(input({ allow_same_group: false }));
    const sources = rulesOf("in", policy).map((rule) => rule.source);

    assert.deepEqual([...new Set(sources)].sort(), ["10.200.0.1", "10.200.0.2"]);
});

test("the allow_same_group-off render is exactly the pre-change policy", () => {
    // Groups whose profile does not allow it must be left untouched by this
    // feature, so the off render is pinned rule by rule rather than by a hash.
    const off = rulesOf("in", buildVmFirewallPolicy(input({ allow_same_group: false })));

    assert.deepEqual(
        off.map((rule) => [
            rule.action, rule.source, rule.proto ?? "any", rule.dport ?? "any",
        ].join(" ")),
        [
            "ACCEPT 10.200.0.2 tcp 3389",
            "ACCEPT 10.200.0.1 icmp any",
            "ACCEPT 10.200.0.2 icmp any",
        ],
    );
});

test("allow_same_group admits the group's own subnet in the one order that is safe", () => {
    // Proxmox stops at the first match, so this list IS the policy. The two
    // DROPs above the subnet ACCEPT are the only thing holding Access to its
    // session ports and the Gateway to ICMP.
    const on = rulesOf("in", buildVmFirewallPolicy(input({ allow_same_group: true })));

    assert.deepEqual(
        on.map((rule) => [
            rule.action,
            rule.source,
            rule.proto ?? "any",
            rule.sport ?? "any",
            rule.dport ?? "any",
        ].join(" ")),
        [
            "ACCEPT 10.200.0.2 tcp any 3389",
            "ACCEPT 10.200.0.1 icmp any any",
            "ACCEPT 10.200.0.2 icmp any any",
            "ACCEPT 10.200.0.1 udp 67 68",
            "DROP 10.200.0.1 any any any",
            "DROP 10.200.0.2 any any any",
            "ACCEPT 10.200.0.0/24 any any any",
        ],
    );
});

test("the same-group accept sits below both infrastructure drops", () => {
    const on = rulesOf("in", buildVmFirewallPolicy(input({ allow_same_group: true })));
    const subnet = on.findIndex((rule) => rule.source === "10.200.0.0/24");
    const dropGateway = on.findIndex((r) => r.action === "DROP" && r.source === "10.200.0.1");
    const dropAccess = on.findIndex((r) => r.action === "DROP" && r.source === "10.200.0.2");

    assert.ok(dropGateway >= 0 && dropAccess >= 0 && subnet >= 0);
    assert.ok(dropGateway < subnet);
    assert.ok(dropAccess < subnet);
});

test("the same-group accept narrows no protocol and no port", () => {
    // "Every port and protocol" is only true if nothing narrows it, and a port
    // without a protocol makes pve-firewall refuse the ruleset.
    const on = rulesOf("in", buildVmFirewallPolicy(input({ allow_same_group: true })));
    const subnet = on.find((rule) => rule.source === "10.200.0.0/24");

    assert.ok(subnet);
    assert.equal(subnet.action, "ACCEPT");
    assert.equal(subnet.proto, undefined);
    assert.equal(subnet.dport, undefined);
    assert.equal(subnet.sport, undefined);
});

test("allow_same_group widens neither Access nor the Gateway", () => {
    const on = rulesOf("in", buildVmFirewallPolicy(input({ allow_same_group: true })));

    // Access: the session-port ACCEPT and ICMP, then a DROP.
    assert.deepEqual(
        on.filter((rule) => rule.source === "10.200.0.2")
            .map((rule) => `${rule.action}:${rule.proto ?? "any"}:${rule.dport ?? "any"}`),
        ["ACCEPT:tcp:3389", "ACCEPT:icmp:any", "DROP:any:any"],
    );
    // Gateway: ICMP and the DHCP reply only, then a DROP.
    assert.deepEqual(
        on.filter((rule) => rule.source === "10.200.0.1")
            .map((rule) => `${rule.action}:${rule.proto ?? "any"}:${rule.dport ?? "any"}`),
        ["ACCEPT:icmp:any", "ACCEPT:udp:68", "DROP:any:any"],
    );
});

test("allow_same_group changes neither the source filter nor egress", () => {
    const on = buildVmFirewallPolicy(input({ allow_same_group: true }));
    const off = buildVmFirewallPolicy(input({ allow_same_group: false }));

    assert.deepEqual(on.ipset, off.ipset);
    assert.deepEqual(on.options, off.options);
    assert.deepEqual(rulesOf("out", on), rulesOf("out", off));
});

test("ICMP is allowed from both infrastructure addresses for path-MTU discovery", () => {
    const icmp = rulesOf("in").filter((rule) => rule.proto === "icmp");

    assert.deepEqual(icmp.map((rule) => rule.source).sort(), ["10.200.0.1", "10.200.0.2"]);
    assert.ok(icmp.every((rule) => rule.action === "ACCEPT"));
});

test("a peered group is admitted in full, and a group cannot peer with itself", () => {
    const policy = buildVmFirewallPolicy(input({ peer_subnet_cidrs: ["10.200.5.0/24"] }));
    const peer = rulesOf("in", policy).find((rule) => rule.source === "10.200.5.0/24");

    assert.ok(peer);
    assert.equal(peer.action, "ACCEPT");
    // Peering permits all routed IP traffic in the first implementation, so no
    // protocol or port narrows it.
    assert.equal(peer.proto, undefined);
    for (const allow of [true, false]) {
        assert.throws(
            () => buildVmFirewallPolicy(input({
                allow_same_group: allow,
                peer_subnet_cidrs: ["10.200.0.0/24"],
            })),
            VmFirewallError,
        );
    }
    // Peering and same-group compose rather than replacing each other.
    const both = rulesOf("in", buildVmFirewallPolicy(input({
        allow_same_group: true,
        peer_subnet_cidrs: ["10.200.5.0/24"],
    })));
    assert.ok(both.some((rule) => rule.source === "10.200.5.0/24"));
    assert.ok(both.some((rule) => rule.source === "10.200.0.0/24"));
});

test("the VM can never answer or relay DHCP", () => {
    // A rogue reply is switched straight to its victim and never crosses a
    // routed hop, so the Gateway structurally cannot see it. Only a DHCP server
    // sends to port 68; a client never does.
    const egress = rulesOf("out");

    assert.ok(egress.some((rule) => (
        rule.action === "DROP" && rule.proto === "udp" && rule.dport === "68"
    )));
    assert.ok(egress.some((rule) => (
        rule.action === "DROP" && rule.proto === "udp" && rule.sport === "67"
    )));
});

test("the VM may not initiate connections into Access", () => {
    // Replies to an Access-initiated session are unaffected: Proxmox evaluates
    // conntrack before these rules.
    assert.ok(rulesOf("out").some((rule) => (
        rule.action === "DROP" && rule.dest === "10.200.0.2"
    )));
});

test("the source filter admits the group's subnet but never the infrastructure addresses", () => {
    // A VM allowed to source from .2 could open a session to a neighbour's RDP
    // port, which is exactly the isolation this policy exists to provide.
    const policy = buildVmFirewallPolicy(input());

    // No `/32` on the host entries: Proxmox stores a single address bare and
    // reports it back that way, so the suffix would make every observation read
    // as drift and every delete miss its target.
    assert.deepEqual(policy.ipset, [
        { cidr: "10.200.0.0/24", nomatch: false, comment: "virtual-lab: the group's own subnet" },
        { cidr: "10.200.0.1", nomatch: true, comment: "virtual-lab: never the Gateway" },
        { cidr: "10.200.0.2", nomatch: true, comment: "virtual-lab: never Access" },
    ]);
    assert.equal(policy.options.ipfilter, true);
    assert.equal(VM_FIREWALL_IPSET, "ipfilter-net0");
});

test("MAC spoofing and IPv6 autoconfiguration are both refused", () => {
    // IPv6 must not become an unfiltered bypass. With neighbour discovery and
    // router advertisements refused it cannot establish on the segment at all.
    const policy = buildVmFirewallPolicy(input());

    assert.equal(policy.options.macfilter, true);
    assert.equal(policy.options.ndp, false);
    assert.equal(policy.options.radv, false);
});

test("DHCP client traffic stays permitted, or the VM would never get an address", () => {
    assert.equal(buildVmFirewallPolicy(input()).options.dhcp, true);
});

test("the revision changes with policy and is stable otherwise", () => {
    assert.equal(
        buildVmFirewallPolicy(input()).revision,
        buildVmFirewallPolicy(input()).revision,
    );
    assert.notEqual(
        buildVmFirewallPolicy(input()).revision,
        buildVmFirewallPolicy(input({ session_ports: [22] })).revision,
    );
    assert.notEqual(
        buildVmFirewallPolicy(input()).revision,
        buildVmFirewallPolicy(input({ peer_subnet_cidrs: ["10.200.5.0/24"] })).revision,
    );
    // Without this the drift reconciler could not tell an opened group from a
    // closed one, and flipping the profile flag would never be repaired.
    assert.notEqual(
        buildVmFirewallPolicy(input({ allow_same_group: false })).revision,
        buildVmFirewallPolicy(input({ allow_same_group: true })).revision,
    );
});

test("session ports are deduplicated and ordered so the revision is stable", () => {
    assert.equal(
        buildVmFirewallPolicy(input({ session_ports: [3389, 22, 22] })).revision,
        buildVmFirewallPolicy(input({ session_ports: [22, 3389] })).revision,
    );
});

test("unverifiable inputs are refused rather than guessed", () => {
    assert.throws(() => buildVmFirewallPolicy(input({ gateway_ip: "not-an-ip" })), VmFirewallError);
    assert.throws(() => buildVmFirewallPolicy(input({ subnet_cidr: "10.200.0.0" })), VmFirewallError);
    // A /0 or /4 would hand the VM most of the address space to spoof from.
    assert.throws(() => buildVmFirewallPolicy(input({ subnet_cidr: "10.0.0.0/0" })), VmFirewallError);
    assert.throws(() => buildVmFirewallPolicy(input({ session_ports: [] })), VmFirewallError);
    assert.throws(() => buildVmFirewallPolicy(input({ session_ports: [70000] })), VmFirewallError);
    // Identical infrastructure addresses would collapse two distinct trust
    // relationships into one.
    assert.throws(
        () => buildVmFirewallPolicy(input({ access_ip: "10.200.0.1" })),
        VmFirewallError,
    );
});

test("session ports mirror what the connection route actually dials", () => {
    // Guessing a superset here would widen the one ingress a student VM has.
    assert.deepEqual(sessionPortsForTemplate("guacamole", {}), [3389]);
    assert.deepEqual(sessionPortsForTemplate("ssh", {}), [22]);
    assert.deepEqual(sessionPortsForTemplate("ssh", { port: 2222 }), [2222]);
    assert.deepEqual(sessionPortsForTemplate("web", { port: 8443 }), [8443]);
    assert.deepEqual(sessionPortsForTemplate(null, null), [3389]);
});
