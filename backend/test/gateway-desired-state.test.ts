import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
    buildGatewayPlan,
    GatewayDesiredStateInput,
    normaliseAllowedDomain,
} from "../src/network/gateway-desired-state";

function baseInput(overrides: Partial<GatewayDesiredStateInput> = {}): GatewayDesiredStateInput {
    return {
        groups: [],
        peerings: [],
        trunk_interface: "ens19",
        uplink_interface: "ens20",
        management_interface: "ens18",
        upstream_resolvers: ["1.1.1.1"],
        management_source_cidrs: ["10.10.10.100/32"],
        ...overrides,
    };
}

function group(vlanTag: number, groupId = vlanTag - 1999, domains: string[] = []) {
    return {
        group_id: groupId,
        vlan_tag: vlanTag,
        subnet_cidr: `10.200.${vlanTag - 2000}.0/24`,
        allowed_web_domains: domains.map((domain) => ({ domain, include_subdomains: true })),
    };
}

test("projects canonical VLAN interfaces, addresses, and DHCP ranges", () => {
    const plan = buildGatewayPlan(baseInput({ groups: [group(2000), group(2001)] }));
    const [first, second] = plan.desired_state.transport.interfaces;

    assert.equal(first.interface_name, "ens19.2000");
    assert.equal(first.address_cidr, "10.200.0.1/24");
    assert.equal(first.gateway_ip, "10.200.0.1");
    assert.equal(first.netmask, "255.255.255.0");
    assert.equal(first.dhcp_first, "10.200.0.25");
    assert.equal(first.dhcp_last, "10.200.0.254");
    assert.equal(second.interface_name, "ens19.2001");
    assert.equal(second.address_cidr, "10.200.1.1/24");
    assert.deepEqual(plan.desired_state.transport.trunk_vlan_ids, [2000, 2001]);
    assert.equal(plan.desired_state.transport.trunk_allowlist, "2000;2001");
});

test("revision covers the renderer version so rendering changes force re-apply", () => {
    const plan = buildGatewayPlan(baseInput({ groups: [group(2000)] }));

    // Without this the revision would be identical after a renderer change, and
    // a host still running the previous output would look converged.
    assert.equal(typeof plan.desired_state.render_version, "number");
    const withOldRenderer = JSON.parse(JSON.stringify(plan.desired_state));
    withOldRenderer.render_version -= 1;
    assert.notEqual(
        createHash("sha256").update(JSON.stringify(withOldRenderer)).digest("hex"),
        plan.revision,
    );
});

test("is deterministic and order independent", () => {
    const forward = buildGatewayPlan(baseInput({ groups: [group(2000), group(2001)] }));
    const reversed = buildGatewayPlan(baseInput({ groups: [group(2001), group(2000)] }));
    assert.equal(forward.revision, reversed.revision);
});

test("expands each undirected peering into both directions", () => {
    const plan = buildGatewayPlan(baseInput({
        groups: [group(2000), group(2001)],
        peerings: [{ group_a_id: 1, group_b_id: 2 }],
    }));

    assert.deepEqual(plan.desired_state.peerings, [
        {
            from_vlan_tag: 2000,
            to_vlan_tag: 2001,
            from_interface: "ens19.2000",
            to_interface: "ens19.2001",
        },
        {
            from_vlan_tag: 2001,
            to_vlan_tag: 2000,
            from_interface: "ens19.2001",
            to_interface: "ens19.2000",
        },
    ]);
});

test("deduplicates a peering supplied in both orderings", () => {
    const plan = buildGatewayPlan(baseInput({
        groups: [group(2000), group(2001)],
        peerings: [
            { group_a_id: 1, group_b_id: 2 },
            { group_a_id: 2, group_b_id: 1 },
        ],
    }));
    assert.equal(plan.desired_state.peerings.length, 2);
});

test("rejects a peering that references an inactive group", () => {
    assert.throws(
        () => buildGatewayPlan(baseInput({
            groups: [group(2000)],
            peerings: [{ group_a_id: 1, group_b_id: 99 }],
        })),
        /without an active VLAN interface/,
    );
});

test("rejects a self peering", () => {
    assert.throws(
        () => buildGatewayPlan(baseInput({
            groups: [group(2000)],
            peerings: [{ group_a_id: 1, group_b_id: 1 }],
        })),
        /references a single group twice/,
    );
});

test("rejects a subnet that does not match its VLAN", () => {
    assert.throws(
        () => buildGatewayPlan(baseInput({
            groups: [{
                group_id: 1,
                vlan_tag: 2000,
                subnet_cidr: "10.200.7.0/24",
                allowed_web_domains: [],
            }],
        })),
        /does not match VLAN 2000/,
    );
});

test("rejects a VLAN outside the approved pool", () => {
    assert.throws(
        () => buildGatewayPlan(baseInput({
            groups: [{
                group_id: 1,
                vlan_tag: 1999,
                subnet_cidr: "10.200.0.0/24",
                allowed_web_domains: [],
            }],
        })),
        /outside the approved pool/,
    );
});

test("rejects duplicate VLAN allocations", () => {
    assert.throws(
        () => buildGatewayPlan(baseInput({ groups: [group(2000, 1), group(2000, 2)] })),
        /duplicate VLAN allocations/,
    );
});

test("requires trunk, uplink, and management interfaces to be distinct", () => {
    assert.throws(
        () => buildGatewayPlan(baseInput({ uplink_interface: "ens19" })),
        /must be distinct/,
    );
});

test("rejects an invalid interface name", () => {
    assert.throws(
        () => buildGatewayPlan(baseInput({ trunk_interface: "eth 0; rm -rf /" })),
        /not a valid interface name/,
    );
});

test("requires at least one upstream resolver and rejects non-IPv4 entries", () => {
    assert.throws(
        () => buildGatewayPlan(baseInput({ upstream_resolvers: [] })),
        /At least one upstream resolver/,
    );
    assert.throws(
        () => buildGatewayPlan(baseInput({ upstream_resolvers: ["dns.example.com"] })),
        /must be a literal IPv4 address/,
    );
});

test("requires at least one management source", () => {
    assert.throws(
        () => buildGatewayPlan(baseInput({ management_source_cidrs: [] })),
        /must not be empty/,
    );
});

test("normalises and deduplicates allowed domains", () => {
    const plan = buildGatewayPlan(baseInput({
        groups: [group(2000, 1, ["Example.COM", " archive.ubuntu.com ", "example.com"])],
    }));
    assert.deepEqual(
        plan.desired_state.transport.interfaces[0].allowed_web_domains.map(({ domain }) => domain),
        ["archive.ubuntu.com", "example.com"],
    );
});

test("rejects a domain listed with conflicting subdomain semantics", () => {
    assert.throws(
        () => buildGatewayPlan(baseInput({
            groups: [{
                group_id: 1,
                vlan_tag: 2000,
                subnet_cidr: "10.200.0.0/24",
                allowed_web_domains: [
                    { domain: "example.com", include_subdomains: true },
                    { domain: "example.com", include_subdomains: false },
                ],
            }],
        })),
        /conflicting include_subdomains/,
    );
});

test("rejects ambiguous domain syntax rather than silently rewriting it", () => {
    for (const invalid of [
        "https://example.com",
        "example.com/path",
        "example.com:443",
        "*.example.com",
        "example.com.",
        ".example.com",
        "localhost",
        "192.168.0.1",
        "exa mple.com",
        "-example.com",
    ]) {
        assert.throws(
            () => normaliseAllowedDomain(invalid),
            new RegExp("Allowed domain"),
            `expected ${invalid} to be rejected`,
        );
    }
});

test("accepts ordinary fully qualified domains", () => {
    assert.equal(normaliseAllowedDomain("archive.ubuntu.com"), "archive.ubuntu.com");
    assert.equal(normaliseAllowedDomain("SECURITY.ubuntu.com"), "security.ubuntu.com");
    assert.equal(normaliseAllowedDomain("a-b.example.co.uk"), "a-b.example.co.uk");
});
