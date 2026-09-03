// -----------------------------------------------------------
//  [*] Network — rendering Gateway configuration files
//
//  GatewayPlan → the literal file contents the Gateway
//  applier installs: networkd units, sysctl, dnsmasq,
//  squid.conf and the nftables ruleset. Every file opens
//  with the plan's revision comment — the convergence
//  signal drift checks look for. The inline comments carry
//  the operational scars; the render-version history in
//  gateway-desired-state.ts indexes them.
//
//  Split into (assembler last):
//
//    nftSet / quotedInterfaces — small format helpers
//    renderNetworkd — trunk parent + VLAN units
//    renderSysctl   — forwarding on, IPv6 off, rp_filter
//    renderDnsmasq  — DHCP/DNS on lab VLANs only
//    renderSquid    — Host/SNI allowlist filtering
//    renderNftables — redirect, input, forward chains
//    renderGatewayConfiguration — the full bundle
//
//  Used by:
//    - adapters/gateway.ts — renderedGatewayFiles
//    - scripts/renderGatewayConfiguration.ts — operator CLI
//    - test/gateway-render.test.ts
// -----------------------------------------------------------

import { GatewayPlan, GatewayVlanInterface } from "./gateway-desired-state";

export type RenderedGatewayConfiguration = {
    revision: string;
    files: {
        networkd: Record<string, string>;
        sysctl: string;
        dnsmasq: string;
        squid: string;
        nftables: string;
    };
};


// nftables inline-set syntax: one value bare, several in braces.
function nftSet(values: Array<string | number>): string {
    if (values.length === 0) {
        throw new Error("Cannot render an empty nftables set");
    }
    return values.length === 1 ? String(values[0]) : `{ ${values.join(", ")} }`;
}


function quotedInterfaces(interfaces: GatewayVlanInterface[]): string[] {
    return interfaces.map(({ interface_name }) => `"${interface_name}"`);
}








// -----------------------------------------------------------
// renderNetworkd
// -----------------------------------------------------------
//
// One `.network` unit for the trunk parent plus a
// .netdev/.network pair per VLAN interface.
//
// A whole `.network` unit for the parent, not a `.network.d`
// drop-in. The drop-in this replaces was silently inert:
// systemd-networkd only reads `<name>.network.d/` next to a
// `<name>.network` that exists, and on this Gateway nothing
// creates one — netplan configures the management and
// uplink NICs only, leaving the trunk parent `unmanaged`
// and down. Every VLAN netdev was therefore declared
// against a link networkd was not configuring, so none was
// ever created. It stayed invisible while no group was
// allocated, because with no interfaces this function
// returns nothing at all. Owning the parent unit outright
// also removes the dependency on a base file somebody made
// by hand — the kind of undeclared prerequisite that
// survives right up until the guest is rebuilt.
//
// Used by:
//   - renderGatewayConfiguration (below)
// -----------------------------------------------------------

function renderNetworkd(plan: GatewayPlan): Record<string, string> {
    const { interfaces, parent_interface } = plan.desired_state.transport;
    if (interfaces.length === 0) {
        return {};
    }

    const files: Record<string, string> = {
        [`/etc/systemd/network/50-virtual-lab-${parent_interface}.network`]: [
            `# Gateway desired-state revision ${plan.revision}.`,
            "[Match]",
            `Name=${parent_interface}`,
            "",
            "[Network]",
            ...interfaces.map(({ interface_name }) => `VLAN=${interface_name}`),
            // The trunk parent carries tagged frames only: it must come up and
            // hold no address of its own, or the Gateway would be reachable on
            // the untagged lab segment every group shares.
            "DHCP=no",
            "IPv6AcceptRA=false",
            "LinkLocalAddressing=no",
            "",
            "[Link]",
            // Boot must not block waiting for a trunk whose peers are student
            // VMs that may not exist yet.
            "RequiredForOnline=no",
            "",
        ].join("\n"),
    };

    for (const { interface_name, address_cidr, vlan_tag } of interfaces) {
        files[`/etc/systemd/network/50-${interface_name}.netdev`] = [
            `# Gateway desired-state revision ${plan.revision}.`,
            "[NetDev]",
            `Name=${interface_name}`,
            "Kind=vlan",
            "",
            "[VLAN]",
            `Id=${vlan_tag}`,
            "",
        ].join("\n");
        files[`/etc/systemd/network/50-${interface_name}.network`] = [
            `# Gateway desired-state revision ${plan.revision}.`,
            "[Match]",
            `Name=${interface_name}`,
            "",
            "[Network]",
            `Address=${address_cidr}`,
            "DHCP=no",
            "IPv6AcceptRA=false",
            "LinkLocalAddressing=no",
            "",
        ].join("\n");
    }
    return files;
}








// -----------------------------------------------------------
// renderSysctl
// -----------------------------------------------------------
//
// Forwarding on, IPv6 off at every level, plus the
// hardening knobs — and refuses to render for a plan that
// claims IPv6.
//
// Used by:
//   - renderGatewayConfiguration (below)
// -----------------------------------------------------------

function renderSysctl(plan: GatewayPlan): string {
    if (plan.desired_state.ipv6_enabled) {
        throw new Error("Gateway rendering requires IPv6 to remain disabled");
    }
    return [
        `# Gateway desired-state revision ${plan.revision}.`,
        "net.ipv4.ip_forward = 1",
        "net.ipv6.conf.all.disable_ipv6 = 1",
        "net.ipv6.conf.default.disable_ipv6 = 1",
        "net.ipv6.conf.lo.disable_ipv6 = 1",
        // Intercepting redirect targets are local sockets; strict reverse-path
        // filtering keeps a spoofed lab source from being routed back out.
        "net.ipv4.conf.all.rp_filter = 1",
        "net.ipv4.conf.default.rp_filter = 1",
        "net.ipv4.conf.all.accept_redirects = 0",
        "net.ipv4.conf.all.send_redirects = 0",
        "net.ipv4.conf.all.accept_source_route = 0",
        "",
    ].join("\n");
}








// -----------------------------------------------------------
// renderDnsmasq
// -----------------------------------------------------------
//
// dnsmasq serves DHCP and DNS on lab VLANs only.
//
// The uplink shares a broadcast domain with other
// infrastructure, so binding there would put a rogue DHCP
// server on someone else's network. bind-dynamic with an
// explicit interface list, plus explicit exceptions, keeps
// that impossible even when the lab VLAN list is empty.
//
// Used by:
//   - renderGatewayConfiguration (below)
// -----------------------------------------------------------

function renderDnsmasq(plan: GatewayPlan): string {
    const desired = plan.desired_state;
    const { interfaces } = desired.transport;
    const lines = [
        `# Gateway desired-state revision ${plan.revision}.`,
        // bind-dynamic, never bind-interfaces. Under bind-interfaces dnsmasq
        // die()s on any interface= name that has no bound address yet, so a
        // newly added VLAN racing systemd-networkd would take DHCP and DNS down
        // for every existing group. bind-dynamic enforces the same
        // interface/except-interface allowlist but tolerates interfaces that
        // appear later.
        "bind-dynamic",
        "no-resolv",
        "no-hosts",
        "domain-needed",
        "bogus-priv",
        "dhcp-authoritative",
        "quiet-dhcp",
        `except-interface=${desired.uplink.interface}`,
        `except-interface=${desired.management.interface}`,
        `no-dhcp-interface=${desired.uplink.interface}`,
        `no-dhcp-interface=${desired.management.interface}`,
    ];

    if (interfaces.length === 0) {
        // No lab VLANs: bind loopback only rather than letting dnsmasq fall back
        // to every interface.
        lines.push("interface=lo", "no-dhcp-interface=lo");
    } else {
        lines.push(...interfaces.map(({ interface_name }) => `interface=${interface_name}`));
    }

    lines.push(...desired.dns.upstream_resolvers.map((resolver) => `server=${resolver}`));

    for (const entry of interfaces) {
        lines.push(
            `dhcp-range=${entry.interface_name},${entry.dhcp_first},${entry.dhcp_last},${entry.netmask},12h`,
            `dhcp-option=${entry.interface_name},option:router,${entry.gateway_ip}`,
            `dhcp-option=${entry.interface_name},option:dns-server,${entry.gateway_ip}`,
        );
    }

    lines.push("");
    return lines.join("\n");
}








// -----------------------------------------------------------
// renderSquid
// -----------------------------------------------------------
//
// Squid filters HTTP by Host and HTTPS by SNI.
//
// `ssl_bump peek` then `splice` reads the handshake's
// server name without decrypting application data, so no CA
// certificate is needed on lab VMs. A connection whose
// destination is not visible, or not allowlisted for the
// source subnet, is denied. The rendered file's own
// comments explain the rest — they ship to the guest.
//
// Used by:
//   - renderGatewayConfiguration (below)
// -----------------------------------------------------------

function renderSquid(plan: GatewayPlan): string {
    const desired = plan.desired_state;
    const lines = [
        `# Gateway desired-state revision ${plan.revision}.`,
        "#",
        "# This is a COMPLETE squid.conf and replaces the distribution file. It is",
        "# deliberately not an /etc/squid/conf.d fragment: the stock Ubuntu config",
        "# already defines http_port 3128 and a Safe_ports ACL, and Squid appends",
        "# rather than replaces both. A duplicate http_port makes Squid fail to",
        "# bind and never start, and an appended Safe_ports silently widens the",
        "# intended 80/443 restriction. ACL names are lab-prefixed for the same",
        "# reason.",
        "",
        "# Squid refuses to start with only intercepting ports, because it needs a",
        "# forward-proxy port to build internal URLs. Bound to loopback so it is not",
        "# a proxy lab VMs could use to sidestep interception; such a request would",
        "# still hit http_access deny all, loopback being in no lab subnet.",
        `http_port 127.0.0.1:${desired.proxy.internal_port}`,
        "",
        `http_port ${desired.proxy.http_port} intercept`,
        `https_port ${desired.proxy.https_port} intercept ssl-bump \\`,
        "    cert=/etc/squid/ssl/gateway-bump.pem \\",
        "    generate-host-certificates=off",
        "",
        "# Intercepted requests must be verified against the address the client",
        "# actually connected to. Without this, Squid only logs a forged Host",
        "# header and then connects to the client-chosen IP, so an allowlisted",
        "# Host value would reach an arbitrary server.",
        "host_verify_strict on",
        "",
        // Squid's default is 30 seconds, spent waiting for in-flight requests to
        // drain before the process exits. The applier restarts Squid on every
        // gateway apply, and an apply runs on every network group creation, so
        // that default was charging ~30s of the ~35s each VM provision spent on
        // gateway policy — measured, not estimated. Draining buys nothing here:
        // the sessions being drained belong to the same lab whose policy is
        // being rewritten by the very apply doing the restart.
        "shutdown_lifetime 1 second",
        "",
        "acl lab_safe_ports port 80 443",
        "acl lab_connect method CONNECT",
        "acl lab_ssl_ports port 443",
        "http_access deny !lab_safe_ports",
        "http_access deny lab_connect !lab_ssl_ports",
        "",
        // Squid expects one space-separated list; repeating the directive is not
        // a reliable way to add resolvers.
        `dns_nameservers ${desired.dns.upstream_resolvers.join(" ")}`,
        "",
        "# Student traffic is not cached, and the Gateway does not advertise",
        "# itself or the originating client to upstream servers.",
        "cache deny all",
        "via off",
        "forwarded_for delete",
        "",
    ];

    // Intercepted TLS reaches Squid as a synthesised `CONNECT <ip>:443`, because
    // the SNI does not exist until Squid has peeked at the ClientHello. A
    // dstdomain ACL therefore cannot match on that request, and denying it is
    // what silently blocked HTTPS to allowlisted domains as well as everything
    // else. The CONNECT is allowed through so the peek can happen, and the
    // allowlist is enforced below at ssl_bump, where the SNI does exist.
    //
    // This is not a hole: nothing is forwarded yet at that point. A connection
    // whose SNI matches no group allowlist -- including one carrying no SNI at
    // all -- is terminated at step 2 before any byte reaches the origin.
    const labSubnets = desired.transport.interfaces.map(({ subnet_cidr }) => subnet_cidr);
    if (labSubnets.length > 0) {
        lines.push(
            `acl lab_any_src src ${labSubnets.join(" ")}`,
            "http_access allow lab_connect lab_ssl_ports lab_any_src",
            "",
        );
    }

    const spliceRules: string[] = [];
    for (const entry of desired.transport.interfaces) {
        const sourceAcl = `lab${entry.vlan_tag}_src`;
        const domainAcl = `lab${entry.vlan_tag}_dom`;
        const sniAcl = `lab${entry.vlan_tag}_sni`;
        lines.push(`acl ${sourceAcl} src ${entry.subnet_cidr}`);
        if (entry.allowed_web_domains.length === 0) {
            // No allowlist means no web access. Denying explicitly keeps the
            // group from falling through to another group's allow rule, and the
            // absence of a splice rule below leaves its TLS terminated.
            lines.push(`http_access deny ${sourceAcl}`, "");
            continue;
        }
        const patterns = entry.allowed_web_domains.map(({ domain, include_subdomains }) => (
            // Squid treats a leading dot as "this domain and its subdomains";
            // without it the match is exact.
            include_subdomains ? `.${domain}` : domain
        ));
        lines.push(
            // -n disables destination-IP reverse lookups. Without it Squid will
            // PTR-resolve a raw-IP destination and match the allowlist against
            // the answer, which the destination's owner controls.
            `acl ${domainAcl} dstdomain -n ${patterns.join(" ")}`,
            // The TLS counterpart, matched against the peeked SNI rather than a
            // request URI. Same patterns, same dot convention.
            `acl ${sniAcl} ssl::server_name ${patterns.join(" ")}`,
            `http_access allow ${sourceAcl} ${domainAcl}`,
            `http_access deny ${sourceAcl}`,
            "",
        );
        // Scoped to the group's own source subnet, so one group's allowlist can
        // never splice another group's connection.
        spliceRules.push(`ssl_bump splice ${sourceAcl} ${sniAcl}`);
    }

    lines.push(
        "http_access deny all",
        "",
        "# Peek at the ClientHello to learn the SNI, splice the connections whose",
        "# SNI matches their own group's allowlist, and terminate the rest. Splice",
        "# means the TLS session is tunnelled untouched: the Gateway never holds a",
        "# key for it and never sees the plaintext, so this filters by name only.",
        "acl step1 at_step SslBump1",
        "ssl_bump peek step1",
        ...spliceRules,
        // Last, and unconditional. Anything that reached here matched no group's
        // allowlist, so it is refused rather than tunnelled.
        "ssl_bump terminate all",
        "",
        "coredump_dir /var/spool/squid",
        "",
    );
    return lines.join("\n");
}








// -----------------------------------------------------------
// renderNftables
// -----------------------------------------------------------
//
// The managed table: the interception redirects
// (prerouting), the input chain scoped to each lab
// interface's own Gateway address, and the forward chain
// whose peering decision deliberately precedes the
// conntrack accept. The rendered comments ship to the guest
// and carry the reasoning at the rule they justify.
//
// Used by:
//   - renderGatewayConfiguration (below)
// -----------------------------------------------------------

function renderNftables(plan: GatewayPlan): string {
    const desired = plan.desired_state;
    const { interfaces } = desired.transport;
    const uplink = `"${desired.uplink.interface}"`;
    const management = `"${desired.management.interface}"`;
    const managementSources = nftSet(desired.management.allowed_sources);

    const lines = [
        `# Gateway desired-state revision ${plan.revision}.`,
        "table inet virtual_lab_gateway {",
        `    comment "Gateway desired-state revision ${plan.revision}"`,
    ];

    if (interfaces.length > 0) {
        lines.push(
            "",
            "    set lab_interfaces {",
            "        type ifname",
            `        elements = { ${quotedInterfaces(interfaces).join(", ")} }`,
            "    }",
            "",
            "    # Each lab interface paired with the Gateway address that belongs",
            "    # to it. A concatenated lookup is the only way to express \"the",
            "    # destination is THIS interface's own address\" in one rule: a plain",
            "    # @lab_interfaces match ignores the destination entirely, so a VM on",
            "    # one VLAN could reach the Gateway on every other VLAN's address and",
            "    # enumerate the groups that exist.",
            "    set lab_interface_addresses {",
            "        typeof iifname . ip daddr",
            `        elements = { ${interfaces
                .map(({ interface_name, address_cidr }) => (
                    `"${interface_name}" . ${address_cidr.split("/")[0]}`
                ))
                .join(", ")} }`,
            "    }",
            "",
            "    set lab_subnets {",
            "        type ipv4_addr",
            "        flags interval",
            `        elements = { ${interfaces.map(({ subnet_cidr }) => subnet_cidr).join(", ")} }`,
            "    }",
            "",
            "    # Destinations that must never be proxied. nat/prerouting runs",
            "    # before the routing decision, so a redirected packet is delivered",
            "    # locally and never traverses the forward chain. Without this set,",
            "    # lab traffic to management or the shared uplink segment on 80/443",
            "    # would be handed to Squid, which would then reach infrastructure",
            "    # that the forward-chain drops exist to protect.",
            "    set non_routable {",
            "        type ipv4_addr",
            "        flags interval",
            "        elements = {",
            "            0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8,",
            "            169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16,",
            "            224.0.0.0/4, 240.0.0.0/4",
            "        }",
            "    }",
        );
        if (desired.peerings.length > 0) {
            lines.push(
                "",
                "    set allowed_pairs {",
                "        type ifname . ifname",
                `        elements = { ${desired.peerings
                    .map(({ from_interface, to_interface }) => `"${from_interface}" . "${to_interface}"`)
                    .join(", ")} }`,
                "    }",
            );
        }
    }

    lines.push(
        "",
        "    chain prerouting_proxy {",
        "        type nat hook prerouting priority dstnat; policy accept;",
    );
    if (interfaces.length > 0) {
        lines.push(
            "        # Peered lab-to-lab traffic is routed, never proxied.",
            "        iifname @lab_interfaces ip daddr @lab_subnets return",
            "        # Infrastructure and private destinations fall through to the",
            "        # forward chain, where they are counted and dropped.",
            "        iifname @lab_interfaces ip daddr @non_routable return",
            "        # Traffic Squid itself emits is locally generated and never",
            "        # re-enters prerouting, so redirection cannot recurse.",
            `        iifname @lab_interfaces meta l4proto tcp tcp dport 80 redirect to :${desired.proxy.http_port}`,
            `        iifname @lab_interfaces meta l4proto tcp tcp dport 443 redirect to :${desired.proxy.https_port}`,
        );
    }
    lines.push("    }", "");

    lines.push(
        "    chain input {",
        "        type filter hook input priority filter; policy drop;",
        "        ct state established,related accept",
        "        ct state invalid drop",
        "        iif lo accept",
        "        # The uplink shares a segment with other infrastructure, so the",
        "        # Gateway exposes no service there beyond DHCP client replies.",
        `        iifname ${uplink} meta l4proto udp udp sport 67 udp dport 68 accept`,
        `        iifname ${management} ip saddr ${managementSources} meta l4proto tcp tcp dport 22 accept`,
        `        iifname ${management} ip saddr ${managementSources} icmp type echo-request accept`,
    );
    if (interfaces.length > 0) {
        lines.push(
            // Scoped to the arrival interface's OWN address. Every service below
            // is already source- or interface-keyed, so reaching another VLAN's
            // Gateway address granted no extra access -- but it did let a VM
            // discover which other groups exist, and a boundary that leaks its
            // own shape is one somebody will eventually find a use for.
            // DHCP is inherently broadcast: DHCPDISCOVER and the SELECTING /
            // INIT-REBOOT / REBINDING forms of DHCPREQUEST are addressed to
            // 255.255.255.255, which is nobody's interface address. Scoping this
            // rule to the interface's own address the way the others are scoped
            // dropped every new client's first packet, while existing VMs kept
            // working because RENEWING is unicast to the server -- so the failure
            // was invisible until the next VM was provisioned.
            //
            // dnsmasq binds per interface, so a broadcast arriving on a lab VLAN
            // is still only ever answered from that VLAN's own scope.
            "        iifname @lab_interfaces ip daddr 255.255.255.255 meta l4proto udp udp dport 67 accept",
            "        iifname . ip daddr @lab_interface_addresses meta l4proto udp udp dport 67 accept",
            "        iifname . ip daddr @lab_interface_addresses meta l4proto udp udp dport 53 accept",
            "        iifname . ip daddr @lab_interface_addresses meta l4proto tcp tcp dport 53 accept",
            `        iifname . ip daddr @lab_interface_addresses meta l4proto tcp tcp dport { ${desired.proxy.http_port}, ${desired.proxy.https_port} } accept`,
            "        iifname . ip daddr @lab_interface_addresses icmp type { echo-request, destination-unreachable, time-exceeded, parameter-problem } accept",
        );
    }
    lines.push("    }", "");

    lines.push(
        "    chain forward {",
        "        type filter hook forward priority filter; policy drop;",
        "        ct state invalid drop",
        // Lab-to-lab is decided against the CURRENT peering, before the blanket
        // conntrack accept below. With the accept first, a flow established
        // while a peering existed keeps being forwarded forever after the
        // peering is deleted -- the ruleset changes, the reconciler reports
        // repaired, and the open RDP session carries on regardless.
        //
        // Return traffic is unaffected: an undirected peering renders BOTH
        // interface-direction tuples into @allowed_pairs, so replies match the
        // accept in their own right rather than relying on conntrack.
        ...(interfaces.length > 0
            ? [
                desired.peerings.length > 0
                    ? "        iifname @lab_interfaces oifname @lab_interfaces iifname . oifname @allowed_pairs accept"
                    : null,
                `        iifname @lab_interfaces oifname @lab_interfaces counter drop comment "cross-group-denied"`,
            ].filter((rule): rule is string => rule !== null)
            : []),
        "        ct state established,related accept",
    );
    if (interfaces.length > 0) {
        lines.push(
            "        # Counted denials for the egress classes the design forbids.",
            "        # Lab-to-lab is already settled above, so these only match",
            "        # uplink-bound traffic.",
            `        iifname @lab_interfaces oifname ${uplink} meta l4proto udp udp dport 443 counter drop comment "quic-denied"`,
            `        iifname @lab_interfaces oifname ${uplink} meta l4proto tcp tcp dport { 80, 443 } counter drop comment "proxy-bypass-denied"`,
            `        iifname @lab_interfaces oifname ${uplink} meta l4proto udp udp dport 53 counter drop comment "external-dns-denied"`,
            `        iifname @lab_interfaces oifname ${uplink} meta l4proto tcp tcp dport { 53, 853 } counter drop comment "external-dns-denied"`,
            `        iifname @lab_interfaces oifname ${uplink} counter drop comment "lab-egress-denied"`,
            // Anything from a lab interface that reached here is bound for
            // neither the uplink nor another lab VLAN -- management, for
            // instance -- and is refused with the same counter.
            `        iifname @lab_interfaces counter drop comment "cross-group-denied"`,
        );
    }
    lines.push("    }", "");

    lines.push(
        "    chain output {",
        "        type filter hook output priority filter; policy accept;",
        "    }",
        "",
        "    # No source NAT chain exists by design. Approved egress is emitted by",
        "    # Squid and the local resolver, which are locally generated and already",
        "    # leave with the uplink address. Forwarded lab traffic never reaches the",
        "    # uplink, so a masquerade rule could only ever widen policy.",
        "}",
        "",
    );

    return lines.join("\n");
}








// -----------------------------------------------------------
// renderGatewayConfiguration
// -----------------------------------------------------------
//
// The full bundle for one plan.
//
// Used by:
//   - adapters/gateway.ts, scripts/renderGatewayConfiguration.ts
// -----------------------------------------------------------

export function renderGatewayConfiguration(plan: GatewayPlan): RenderedGatewayConfiguration {
    return {
        revision: plan.revision,
        files: {
            networkd: renderNetworkd(plan),
            sysctl: renderSysctl(plan),
            dnsmasq: renderDnsmasq(plan),
            squid: renderSquid(plan),
            nftables: renderNftables(plan),
        },
    };
}
