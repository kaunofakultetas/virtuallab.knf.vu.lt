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

    const files: Record<string, string> = {
        "/etc/systemd/network/eth1.network.d/50-virtual-lab-vlans.conf": [
            `# Access desired-state revision ${plan.revision}.`,
            "[Network]",
            ...interfaces.map(({ interface_name }) => `VLAN=${interface_name}`),
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

    if (desired.transport.interfaces.length > 0) {
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