// -----------------------------------------------------------
//  [*] Tests — the rendered Gateway configuration
//
//  The squid.conf, dnsmasq, nftables and networkd text
//  renderGatewayConfiguration emits — SNI splicing, DHCP
//  broadcast, counted denials and all.
//
//  Covers src/network/gateway-render.ts. Run with `npm test`
//  (the whole suite) inside the backend container.
// -----------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import {
    buildGatewayPlan,
    GatewayDesiredStateInput,
} from "../src/network/gateway-desired-state";
import { renderGatewayConfiguration } from "../src/network/gateway-render";

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

function render(input: GatewayDesiredStateInput) {
    return renderGatewayConfiguration(buildGatewayPlan(input));
}

test("dnsmasq uses bind-dynamic so a late VLAN cannot kill the daemon", () => {
    const { files } = render(baseInput({ groups: [group(2000), group(2001)] }));

    // bind-interfaces makes dnsmasq die() on any interface= name without a bound
    // address, so one VLAN racing systemd-networkd would take DHCP and DNS down
    // for every existing group.
    assert.match(files.dnsmasq, /^bind-dynamic$/m);
    assert.doesNotMatch(files.dnsmasq, /^bind-interfaces$/m);
});

test("dnsmasq never binds or serves DHCP on the uplink", () => {
    const { files } = render(baseInput({ groups: [group(2000, 1, ["example.com"])] }));

    assert.match(files.dnsmasq, /^bind-dynamic$/m);
    assert.match(files.dnsmasq, /^except-interface=ens20$/m);
    assert.match(files.dnsmasq, /^no-dhcp-interface=ens20$/m);
    assert.match(files.dnsmasq, /^interface=ens19\.2000$/m);
    // The uplink must never appear as a served interface.
    assert.doesNotMatch(files.dnsmasq, /^interface=ens20$/m);
    assert.doesNotMatch(files.dnsmasq, /^dhcp-range=ens20/m);
});

test("dnsmasq binds only loopback when no lab VLAN exists", () => {
    const { files } = render(baseInput());

    // An empty interface list would otherwise let dnsmasq fall back to every
    // interface, putting a DHCP server on the shared uplink segment.
    assert.match(files.dnsmasq, /^interface=lo$/m);
    assert.doesNotMatch(files.dnsmasq, /^dhcp-range=/m);
});

test("dnsmasq advertises the gateway as router and resolver per VLAN", () => {
    const { files } = render(baseInput({ groups: [group(2000), group(2001)] }));

    assert.match(files.dnsmasq, /^dhcp-range=ens19\.2000,10\.200\.0\.25,10\.200\.0\.254,255\.255\.255\.0,12h$/m);
    assert.match(files.dnsmasq, /^dhcp-option=ens19\.2000,option:router,10\.200\.0\.1$/m);
    assert.match(files.dnsmasq, /^dhcp-option=ens19\.2000,option:dns-server,10\.200\.0\.1$/m);
    assert.match(files.dnsmasq, /^dhcp-option=ens19\.2001,option:router,10\.200\.1\.1$/m);
    assert.match(files.dnsmasq, /^server=1\.1\.1\.1$/m);
    assert.match(files.dnsmasq, /^no-resolv$/m);
});

test("squid allows only each subnet's own allowlist and denies the rest", () => {
    const { files } = render(baseInput({
        groups: [
            group(2000, 1, ["archive.ubuntu.com"]),
            group(2001, 2, ["example.org"]),
        ],
    }));

    assert.match(files.squid, /^acl lab2000_src src 10\.200\.0\.0\/24$/m);
    assert.match(files.squid, /^acl lab2000_dom dstdomain -n \.archive\.ubuntu\.com$/m);
    assert.match(files.squid, /^http_access allow lab2000_src lab2000_dom$/m);
    assert.match(files.squid, /^http_access deny lab2000_src$/m);
    assert.match(files.squid, /^acl lab2001_dom dstdomain -n \.example\.org$/m);
    // A trailing catch-all keeps an unmatched source from reaching anything.
    assert.match(files.squid, /^http_access deny all$/m);
});

test("squid lists every upstream resolver on one directive", () => {
    const { files } = render(baseInput({
        groups: [group(2000, 1, ["example.com"])],
        upstream_resolvers: ["1.1.1.1", "9.9.9.9"],
    }));

    assert.match(files.squid, /^dns_nameservers 1\.1\.1\.1 9\.9\.9\.9$/m);
    assert.equal(files.squid.match(/^dns_nameservers /gm)?.length, 1);
});

test("squid splices without decrypting and never generates host certificates", () => {
    const { files } = render(baseInput({ groups: [group(2000, 1, ["example.com"])] }));

    assert.match(files.squid, /ssl_bump peek step1/);
    assert.match(files.squid, /^ssl_bump splice lab2000_src lab2000_sni$/m);
    assert.match(files.squid, /generate-host-certificates=off/);
    // Bumping would mean holding a key for student TLS and seeing the
    // plaintext. Filtering is by name only.
    assert.doesNotMatch(files.squid, /ssl_bump bump/);
});

test("squid terminates any TLS whose SNI matches no allowlist", () => {
    // The unconditional terminate must come last: anything reaching it matched
    // no group's allowlist, including a connection carrying no SNI at all.
    const { files } = render(baseInput({
        groups: [group(2000, 1, ["example.com"]), group(2001, 2, ["example.org"])],
    }));
    const rules = (files.squid.match(/^ssl_bump .*$/gm) ?? []);

    assert.deepEqual(rules, [
        "ssl_bump peek step1",
        "ssl_bump splice lab2000_src lab2000_sni",
        "ssl_bump splice lab2001_src lab2001_sni",
        "ssl_bump terminate all",
    ]);
});

test("squid lets the intercepted CONNECT reach the peek, then filters on SNI", () => {
    // Intercepted TLS arrives as `CONNECT <ip>:443`; the SNI does not exist
    // until Squid peeks. Denying that request is what blocked HTTPS to
    // allowlisted domains as well as everything else.
    const { files } = render(baseInput({ groups: [group(2000, 1, ["example.com"])] }));

    assert.match(files.squid, /^acl lab_any_src src 10\.200\.0\.0\/24$/m);
    assert.match(files.squid, /^http_access allow lab_connect lab_ssl_ports lab_any_src$/m);
    assert.match(files.squid, /^acl lab2000_sni ssl::server_name \.example\.com$/m);
});

test("a group's splice rule is scoped to its own source subnet", () => {
    // Without the source ACL, one group's allowlist would splice another
    // group's connection to the same domain.
    const { files } = render(baseInput({
        groups: [group(2000, 1, ["example.com"]), group(2001, 2, ["example.org"])],
    }));

    assert.match(files.squid, /^ssl_bump splice lab2000_src lab2000_sni$/m);
    assert.doesNotMatch(files.squid, /^ssl_bump splice lab2000_sni$/m);
});

test("squid verifies intercepted Host headers strictly", () => {
    const { files } = render(baseInput({ groups: [group(2000, 1, ["example.com"])] }));

    // Without this, Squid only logs a forged Host header and still connects to
    // the client-chosen IP, so an allowlisted Host reaches an arbitrary server.
    assert.match(files.squid, /^host_verify_strict on$/m);
});

test("squid never reverse-resolves a destination IP to match the allowlist", () => {
    const { files } = render(baseInput({
        groups: [group(2000, 1, ["archive.ubuntu.com"]), group(2001, 2, ["example.org"])],
    }));

    // Every dstdomain ACL must carry -n; otherwise the destination owner can
    // publish a PTR record that matches an allowlisted domain.
    const dstdomainLines = files.squid.match(/^acl \S+ dstdomain .*$/gm) ?? [];
    assert.ok(dstdomainLines.length > 0);
    for (const line of dstdomainLines) {
        assert.match(line, /dstdomain -n /, `missing -n: ${line}`);
    }
});

test("squid has a loopback-only forward-proxy port so it can actually start", () => {
    const { files } = render(baseInput({ groups: [group(2000, 1, ["example.com"])] }));

    // With only intercept ports Squid parses cleanly but dies at startup with
    // "cannot parse internal URL: http://<host>:0/...".
    assert.match(files.squid, /^http_port 127\.0\.0\.1:3130$/m);
    // It must not be reachable off-box, or it would be a proxy that bypasses
    // per-subnet interception policy.
    assert.doesNotMatch(files.squid, /^http_port 3130$/m);
});

test("squid is a complete config with lab-prefixed ACLs, not a conf.d fragment", () => {
    const { files } = render(baseInput({ groups: [group(2000, 1, ["example.com"])] }));

    // Stock Ubuntu squid.conf already defines these names and appends rather
    // than replaces, so reusing them would silently widen policy.
    assert.doesNotMatch(files.squid, /^acl Safe_ports/m);
    assert.doesNotMatch(files.squid, /^acl SSL_ports/m);
    assert.doesNotMatch(files.squid, /^acl CONNECT/m);
    assert.match(files.squid, /^acl lab_safe_ports port 80 443$/m);
    assert.match(files.squid, /^http_access deny !lab_safe_ports$/m);

    // Two ports by design: the loopback forward-proxy Squid needs to start, and
    // the intercept port. Neither may be declared twice, which is what collides
    // with the distribution config.
    const ports = files.squid.match(/^http_port .*$/gm) ?? [];
    assert.deepEqual(ports, ["http_port 127.0.0.1:3130", "http_port 3128 intercept"]);
    assert.equal(new Set(ports).size, ports.length);
});

test("squid neither caches student traffic nor advertises the client", () => {
    const { files } = render(baseInput({ groups: [group(2000, 1, ["example.com"])] }));

    assert.match(files.squid, /^cache deny all$/m);
    assert.match(files.squid, /^via off$/m);
    assert.match(files.squid, /^forwarded_for delete$/m);
});

test("squid distinguishes exact domains from subdomain matches", () => {
    const { files } = render(baseInput({
        groups: [{
            group_id: 1,
            vlan_tag: 2000,
            subnet_cidr: "10.200.0.0/24",
            allowed_web_domains: [
                { domain: "exact.example.com", include_subdomains: false },
                { domain: "wide.example.com", include_subdomains: true },
            ],
        }],
    }));

    assert.match(files.squid, /^acl lab2000_dom dstdomain -n exact\.example\.com \.wide\.example\.com$/m);
});

test("squid denies a group that has no allowlist, over HTTP and TLS alike", () => {
    const { files } = render(baseInput({ groups: [group(2000)] }));

    assert.match(files.squid, /^http_access deny lab2000_src$/m);
    // No per-group allow, so plain HTTP is refused...
    assert.doesNotMatch(files.squid, /^http_access allow lab2000_src/m);
    // ...and no splice rule, so its TLS falls through to terminate.
    assert.doesNotMatch(files.squid, /^ssl_bump splice lab2000_src/m);
    assert.match(files.squid, /^ssl_bump terminate all$/m);
});

test("nftables redirects lab web traffic but exempts peered lab destinations", () => {
    const { files } = render(baseInput({ groups: [group(2000), group(2001)] }));

    assert.match(files.nftables, /iifname @lab_interfaces ip daddr @lab_subnets return/);
    const returnIndex = files.nftables.indexOf("ip daddr @lab_subnets return");
    const redirectIndex = files.nftables.indexOf("tcp dport 80 redirect");
    // The exemption must precede the redirect or peered HTTP would be proxied.
    assert.ok(returnIndex >= 0 && redirectIndex > returnIndex);
    assert.match(files.nftables, /tcp dport 80 redirect to :3128/);
    assert.match(files.nftables, /tcp dport 443 redirect to :3129/);
});

test("nftables never proxies lab traffic aimed at infrastructure", () => {
    const { files } = render(baseInput({ groups: [group(2000)] }));

    // nat/prerouting precedes routing, so a redirected packet never reaches the
    // forward drops. Private destinations must fall through instead.
    assert.match(files.nftables, /set non_routable/);
    for (const cidr of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"]) {
        assert.ok(files.nftables.includes(cidr), `non_routable is missing ${cidr}`);
    }
    const nonRoutableReturn = files.nftables.indexOf("ip daddr @non_routable return");
    const redirectIndex = files.nftables.indexOf("tcp dport 80 redirect");
    assert.ok(nonRoutableReturn >= 0 && redirectIndex > nonRoutableReturn);
});

test("nftables admits every configured management source to SSH", () => {
    const { files } = render(baseInput({
        groups: [group(2000)],
        management_source_cidrs: ["10.10.10.1/32", "10.10.10.100/32"],
    }));

    // A ruleset that admits only one of the two would lock out the other. The
    // Gateway has no serial console, so recovery would mean offline surgery.
    assert.match(files.nftables, /ip saddr \{ 10\.10\.10\.1\/32, 10\.10\.10\.100\/32 \}.*dport 22 accept/);
});

test("nftables defaults both filter chains to drop", () => {
    const { files } = render(baseInput({ groups: [group(2000)] }));

    assert.match(files.nftables, /type filter hook input priority filter; policy drop;/);
    assert.match(files.nftables, /type filter hook forward priority filter; policy drop;/);
});

test("nftables exposes no service on the uplink beyond DHCP client replies", () => {
    const { files } = render(baseInput({ groups: [group(2000)] }));
    const inputChain = files.nftables.slice(
        files.nftables.indexOf("chain input"),
        files.nftables.indexOf("chain forward"),
    );

    const uplinkRules = inputChain.split("\n").filter((line) => line.includes('"ens20"'));
    assert.equal(uplinkRules.length, 1);
    assert.match(uplinkRules[0], /udp sport 67 udp dport 68 accept/);
    // Management services must not be reachable from lab VLANs.
    assert.doesNotMatch(inputChain, /@lab_interfaces .*dport 22/);
});

test("nftables renders both peering directions and denies unpeered groups", () => {
    const { files } = render(baseInput({
        groups: [group(2000), group(2001), group(2002)],
        peerings: [{ group_a_id: 1, group_b_id: 2 }],
    }));

    // Scoped to the peering set: other concatenated sets legitimately name every
    // interface, so asserting against the whole file would pass or fail for
    // reasons that have nothing to do with peering.
    const allowedPairs = files.nftables.slice(
        files.nftables.indexOf("set allowed_pairs"),
    ).split("}")[0];

    assert.match(allowedPairs, /"ens19\.2000" \. "ens19\.2001"/);
    assert.match(allowedPairs, /"ens19\.2001" \. "ens19\.2000"/);
    assert.doesNotMatch(allowedPairs, /ens19\.2002/);
    assert.match(files.nftables, /iifname \. oifname @allowed_pairs accept/);
    assert.match(files.nftables, /counter drop comment "cross-group-denied"/);
});

test("the input chain admits each VLAN only on its own Gateway address", () => {
    // Every service in that chain is source- or interface-keyed, so reaching
    // another VLAN's Gateway address granted no extra access -- but it did let a
    // VM enumerate which other groups exist.
    const { files } = render(baseInput({ groups: [group(2000), group(2001)] }));
    const pairs = files.nftables.slice(
        files.nftables.indexOf("set lab_interface_addresses"),
    ).split("}")[0];

    assert.match(pairs, /"ens19\.2000" \. 10\.200\.0\.1/);
    assert.match(pairs, /"ens19\.2001" \. 10\.200\.1\.1/);
    // Every service rule is scoped to the arrival interface's own address. The
    // one exception is broadcast DHCP, which by protocol cannot be: see the
    // dedicated test below. Asserting the unscoped form is absent entirely is
    // what previously hid a broken DHCP rule behind a green test.
    const input = files.nftables.slice(files.nftables.indexOf("hook input")).split("}")[0];
    const unscoped = (input.match(/^.*iifname @lab_interfaces.*$/gm) ?? []);
    assert.equal(unscoped.length, 1, `unexpected unscoped rule(s): ${unscoped.join(" | ")}`);
    assert.match(unscoped[0], /255\.255\.255\.255.*dport 67/);
    assert.match(input, /iifname \. ip daddr @lab_interface_addresses .*dport 53 accept/);
});

test("broadcast DHCP is admitted, or no VM can ever take a lease", () => {
    // DHCPDISCOVER and the SELECTING/INIT-REBOOT/REBINDING requests go to
    // 255.255.255.255, which is nobody's interface address. Scoping udp/67 the
    // way the other input rules are scoped silently broke every NEW client while
    // existing VMs kept renewing by unicast.
    const { files } = render(baseInput({ groups: [group(2000), group(2001)] }));
    const input = files.nftables.slice(files.nftables.indexOf("hook input")).split("}")[0];

    assert.match(
        input,
        /iifname @lab_interfaces ip daddr 255\.255\.255\.255 .*dport 67 accept/,
    );
    // The unicast renewal path stays scoped to the interface's own address.
    assert.match(input, /iifname \. ip daddr @lab_interface_addresses .*dport 67 accept/);
    // Broadcast is admitted for DHCP only -- never for DNS or the proxy ports.
    const broadcastRules = input.match(/^.*255\.255\.255\.255.*$/gm) ?? [];
    assert.equal(broadcastRules.length, 1);
    assert.match(broadcastRules[0], /dport 67/);
});

test("lab-to-lab is decided before the conntrack accept, so unpeering kills live flows", () => {
    // With `ct state established,related accept` first, a flow opened while a
    // peering existed keeps being forwarded forever after the peering is
    // deleted: the ruleset changes, the reconciler reports repaired, and the
    // open session carries on regardless.
    const { files } = render(baseInput({
        groups: [group(2000), group(2001)],
        peerings: [{ group_a_id: 1, group_b_id: 2 }],
    }));
    const forward = files.nftables.slice(files.nftables.indexOf("hook forward")).split("}")[0];

    const labToLabAccept = forward.indexOf("oifname @lab_interfaces iifname . oifname @allowed_pairs");
    const labToLabDrop = forward.indexOf('oifname @lab_interfaces counter drop comment "cross-group-denied"');
    const ctAccept = forward.indexOf("ct state established,related accept");

    assert.ok(labToLabAccept >= 0 && labToLabDrop >= 0 && ctAccept >= 0);
    assert.ok(labToLabAccept < labToLabDrop, "peered accept must precede the lab-to-lab drop");
    assert.ok(labToLabDrop < ctAccept, "lab-to-lab must be settled before the conntrack accept");
});

test("uplink return traffic still relies on conntrack", () => {
    // The lab-to-lab drop is scoped to `oifname @lab_interfaces`, so a reply
    // arriving from the uplink is untouched by it and still matches the
    // established accept. Without that scoping, all web egress would break.
    const { files } = render(baseInput({ groups: [group(2000)] }));
    const forward = files.nftables.slice(files.nftables.indexOf("hook forward")).split("}")[0];
    const dropLine = (forward.match(/^.*cross-group-denied.*$/m) ?? [""])[0];

    assert.match(dropLine, /iifname @lab_interfaces oifname @lab_interfaces/);
    assert.match(forward, /ct state established,related accept/);
});

test("nftables omits the peering set when nothing is peered", () => {
    const { files } = render(baseInput({ groups: [group(2000), group(2001)] }));

    assert.doesNotMatch(files.nftables, /allowed_pairs/);
    assert.match(files.nftables, /counter drop comment "cross-group-denied"/);
});

test("nftables counts the forbidden egress classes", () => {
    const { files } = render(baseInput({ groups: [group(2000)] }));

    assert.match(files.nftables, /udp dport 443 counter drop comment "quic-denied"/);
    assert.match(files.nftables, /tcp dport \{ 80, 443 \} counter drop comment "proxy-bypass-denied"/);
    assert.match(files.nftables, /tcp dport \{ 53, 853 \} counter drop comment "external-dns-denied"/);
    assert.match(files.nftables, /udp dport 53 counter drop comment "external-dns-denied"/);
});

test("nftables applies no source NAT", () => {
    const { files } = render(baseInput({ groups: [group(2000)] }));

    // Assert on rules only; the ruleset carries a comment explaining why source
    // NAT is deliberately absent, and matching that would be a false positive.
    const rules = files.nftables
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"));

    // Forwarded lab traffic never reaches the uplink, so masquerading could only
    // widen policy.
    assert.ok(!rules.some((line) => /\bmasquerade\b/.test(line)));
    assert.ok(!rules.some((line) => /\bsnat\b/.test(line)));
    assert.ok(!rules.some((line) => /hook postrouting/.test(line)));
});

test("networkd creates one VLAN netdev and network per group", () => {
    const { files } = render(baseInput({ groups: [group(2000)] }));

    assert.match(
        files.networkd["/etc/systemd/network/50-ens19.2000.netdev"],
        /Kind=vlan[\s\S]*Id=2000/,
    );
    assert.match(
        files.networkd["/etc/systemd/network/50-ens19.2000.network"],
        /Address=10\.200\.0\.1\/24/,
    );
    assert.match(
        files.networkd["/etc/systemd/network/50-virtual-lab-ens19.network"],
        /VLAN=ens19\.2000/,
    );
});

test("the trunk parent is configured by a whole unit, not a drop-in", () => {
    // systemd-networkd reads `<name>.network.d/` only next to a `<name>.network`
    // that exists. Nothing on the Gateway creates one — netplan configures the
    // management and uplink NICs only — so a drop-in was silently inert and no
    // VLAN netdev was ever created.
    const { files } = render(baseInput({ groups: [group(2000)] }));
    const parent = files.networkd["/etc/systemd/network/50-virtual-lab-ens19.network"];

    assert.ok(
        !Object.keys(files.networkd).some((path) => path.includes(".network.d/")),
        "no drop-in may be emitted for a parent unit that does not exist",
    );
    assert.match(parent, /\[Match\]\nName=ens19/);
    assert.match(parent, /RequiredForOnline=no/);
});

test("the trunk parent holds no address of its own", () => {
    // It carries tagged frames only. An address here would put the Gateway on
    // the untagged segment every group's trunk shares.
    const { files } = render(baseInput({ groups: [group(2000), group(2001)] }));
    const parent = files.networkd["/etc/systemd/network/50-virtual-lab-ens19.network"];

    assert.ok(!/^Address=/m.test(parent));
    assert.match(parent, /DHCP=no/);
    assert.match(parent, /LinkLocalAddressing=no/);
    assert.match(parent, /VLAN=ens19\.2000\nVLAN=ens19\.2001/);
});

test("sysctl disables IPv6 and enables forwarding", () => {
    const { files } = render(baseInput({ groups: [group(2000)] }));

    assert.match(files.sysctl, /^net\.ipv4\.ip_forward = 1$/m);
    assert.match(files.sysctl, /^net\.ipv6\.conf\.all\.disable_ipv6 = 1$/m);
    assert.match(files.sysctl, /^net\.ipv4\.conf\.all\.rp_filter = 1$/m);
});

test("every rendered file carries the desired-state revision", () => {
    const rendered = render(baseInput({ groups: [group(2000, 1, ["example.com"])] }));

    for (const content of [
        rendered.files.sysctl,
        rendered.files.dnsmasq,
        rendered.files.squid,
        rendered.files.nftables,
        ...Object.values(rendered.files.networkd),
    ]) {
        assert.ok(
            content.includes(rendered.revision),
            "rendered file is missing the revision marker",
        );
    }
});
