import { AccessPlan } from "./access-desired-state";

export type RenderedAccessConfiguration = {
    revision: string;
    files: {
        networkd: Record<string, string>;
        sysctl: string;
        nftables: string;
    };
};

function nftSet(values: Array<string | number>): string {
    if (values.length === 0) {
        throw new Error("Cannot render an empty nftables set");
    }
    return values.length === 1 ? String(values[0]) : `{ ${values.join(", ")} }`;
}

function renderNetworkd(plan: AccessPlan): Record<string, string> {
    const interfaces = plan.desired_state.transport.interfaces;
    if (interfaces.length === 0) {
        return {};
    }

    // A whole `.network` unit for the trunk parent, not a `.network.d` drop-in.
    //
    // The drop-in this replaces worked only because Proxmox happens to generate
    // `/etc/systemd/network/eth1.network` for a container NIC, and
    // systemd-networkd reads `<name>.network.d/` only beside a `<name>.network`
    // that exists. That made a PVE implementation detail -- the filename it
    // chooses -- load-bearing for every lab VLAN interface, with no signal if it
    // ever changed. The identical arrangement on the Gateway was silently inert
    // for exactly this reason, because nothing there generated the base file at
    // all.
    //
    // `50-` sorts ahead of PVE's `eth1.network`, so this unit wins while leaving
    // PVE's own file untouched.
    const parent = plan.desired_state.transport.parent_interface;
    const files: Record<string, string> = {
        [`/etc/systemd/network/50-virtual-lab-${parent}.network`]: [
            `# Access desired-state revision ${plan.revision}.`,
            "[Match]",
            `Name=${parent}`,
            "",
            "[Network]",
            ...interfaces.map(({ interface_name }) => `VLAN=${interface_name}`),
            // The trunk parent carries tagged frames only. An address here would
            // put Access on the untagged segment every group's trunk shares,
            // which is the transport the migration deliberately retired.
            "DHCP=no",
            "IPv6AcceptRA=false",
            "LinkLocalAddressing=no",
            "",
        ].join("\n"),
    };
    for (const { interface_name, address_cidr, vlan_tag } of interfaces) {
        files[`/etc/systemd/network/50-${interface_name}.netdev`] = [
            `# Access desired-state revision ${plan.revision}.`,
            "[NetDev]",
            `Name=${interface_name}`,
            "Kind=vlan",
            "",
            "[VLAN]",
            `Id=${vlan_tag}`,
            "",
        ].join("\n");
        files[`/etc/systemd/network/50-${interface_name}.network`] = [
            `# Access desired-state revision ${plan.revision}.`,
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

function renderSysctl(plan: AccessPlan): string {
    if (plan.desired_state.ipv6_enabled) {
        throw new Error("Access rendering requires IPv6 to remain disabled");
    }
    return [
        `# Access desired-state revision ${plan.revision}.`,
        "net.ipv4.ip_forward = 1",
        "net.ipv6.conf.all.disable_ipv6 = 1",
        "net.ipv6.conf.default.disable_ipv6 = 1",
        "net.ipv6.conf.lo.disable_ipv6 = 1",
        "",
    ].join("\n");
}

function renderNftables(plan: AccessPlan): string {
    const desired = plan.desired_state;
    const managementAddress = desired.management.address_cidr.split("/")[0];
    const managementSources = nftSet(desired.management.allowed_sources);
    const servicePorts = nftSet(desired.management.service_ports);
    const rules = [
        `# Access desired-state revision ${plan.revision}.`,
        // Self-contained load. The create-then-delete prelude makes `nft -f` on
        // this file alone idempotent, which is what lets the applier load it
        // directly instead of reloading /etc/nftables.conf. That distinction is
        // not cosmetic: /etc/nftables.conf opens with `flush ruleset`, which
        // destroys every table in the namespace — including the `ip nat` table
        // holding Docker's MASQUERADE rules. Without those, Guacamole's
        // container reaches student VMs as 172.18.x.x instead of the Access
        // appliance's VLAN address, and every per-VM firewall drops it.
        "table inet virtual_lab_access {}",
        "delete table inet virtual_lab_access",
        "",
        "table inet virtual_lab_access {",
        `    comment "Access desired-state revision ${plan.revision}"`,
        "    chain protect_published_services {",
        "        type filter hook prerouting priority raw; policy accept;",
        `        ip daddr ${managementAddress} tcp dport ${servicePorts} ip saddr ${managementSources} accept`,
        `        ip daddr ${managementAddress} tcp dport ${servicePorts} drop`,
        "    }",
        "",
        "    chain forward {",
        "        type filter hook forward priority filter; policy drop;",
        "        ct state established,related accept",
        `        ip saddr ${managementSources} ct original ip daddr ${managementAddress} meta l4proto tcp ct original proto-dst ${servicePorts} accept`,
    ];

    if (desired.transport.interfaces.length === 0) {
        // Zero allocated groups is a legitimate steady state, so the empty
        // forward chain is stated rather than left to fall out of a skipped
        // branch. The Docker accept cannot simply always be emitted: nftables
        // has no empty inline set, so the rule would have to shed its ip daddr
        // and oifname restrictions, widening "Docker to lab subnets" into
        // "Docker to anywhere routable". Named sets could carry the emptiness
        // instead, but an accept over empty sets matches exactly the packets
        // that no accept at all matches, and it would rewrite the rule shape
        // for the allocated case already loaded on the host. Either way the
        // security property is the policy drop, which is what denies
        // lab-to-lab, lab-to-management and use of Access as a router.
        rules.push(
            "        # No lab VLANs are allocated in this revision, so no interface",
            "        # exists to accept Docker-sourced traffic towards. Return traffic",
            "        # and the published service path above are the only forwarded",
            "        # flows; policy drop denies the rest.",
        );
    } else {
        const dockerCidrs = nftSet(desired.docker.bridge_cidrs);
        const labCidrs = nftSet(
            desired.transport.interfaces.map(({ subnet_cidr }) => subnet_cidr),
        );
        const vlanInterfaces = nftSet(
            desired.transport.interfaces.map(({ interface_name }) => `"${interface_name}"`),
        );
        rules.push(
            `        ip saddr ${dockerCidrs} ip daddr ${labCidrs} oifname ${vlanInterfaces} accept`,
        );
    }

    rules.push(
        "    }",
        "}",
        "",
    );
    return rules.join("\n");
}

export function renderAccessConfiguration(plan: AccessPlan): RenderedAccessConfiguration {
    if (
        plan.desired_state.transport.interfaces.length > 0 &&
        plan.desired_state.docker.bridge_cidrs.length === 0
    ) {
        throw new Error("Active Access VLANs require at least one observed Docker bridge CIDR");
    }
    return {
        revision: plan.revision,
        files: {
            networkd: renderNetworkd(plan),
            sysctl: renderSysctl(plan),
            nftables: renderNftables(plan),
        },
    };
}