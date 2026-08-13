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
    const session = rulesOf("in", policy)[0];

    assert.equal(session.action, "ACCEPT");
    assert.equal(session.source, "10.200.0.2");
    assert.equal(session.proto, "tcp");
    assert.equal(session.dport, "22");
});

test("no rule admits another student VM", () => {
    // Same-group VMs belong to one owner, but nothing in the rendered policy may
    // assume that: a source that is neither infrastructure nor a peered subnet
    // must fall through to the DROP policy.
    const policy = buildVmFirewallPolicy(input());
    const sources = rulesOf("in", policy).map((rule) => rule.source);

    assert.deepEqual([...new Set(sources)].sort(), ["10.200.0.1", "10.200.0.2"]);
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
    assert.throws(
        () => buildVmFirewallPolicy(input({ peer_subnet_cidrs: ["10.200.0.0/24"] })),
        VmFirewallError,
    );
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
