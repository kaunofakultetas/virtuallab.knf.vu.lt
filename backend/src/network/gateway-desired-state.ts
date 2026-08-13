import { createHash } from "node:crypto";
import { isIP } from "node:net";
import {
    networkProjectionConfig,
    NetworkProjectionConfig,
    validateNetworkProjectionConfig,
} from "./config";

/**
 * Version of the rendered configuration's semantics.
 *
 * The revision hashes the desired-state document, so a change to the renderers
 * alone would otherwise produce an identical revision and a host still running
 * the previous output would look converged. Bump this whenever rendered policy
 * changes meaning, so drift detection re-applies.
 *
 * 2: dstdomain -n, host_verify_strict, complete squid.conf with lab-prefixed
 *    ACLs, dnsmasq bind-dynamic, and the non_routable proxy exemption.
 * 3: loopback-only forward-proxy port, without which Squid parses but refuses
 *    to start.
 * 4: the trunk parent gets its own `.network` unit instead of a drop-in beside
 *    a file that never existed, and HTTPS is filtered on the peeked SNI at
 *    ssl_bump rather than on a dstdomain the intercepted CONNECT cannot carry.
 *    Both were inert rather than wrong-looking: the first created no VLAN
 *    interface at all, the second denied every HTTPS request including
 *    allowlisted ones.
 * 5: the input chain is scoped to each lab interface's own Gateway address via a
 *    concatenated set, so a VM can no longer reach -- and enumerate -- the
 *    Gateway on other groups' VLAN addresses.
 * 6: broadcast DHCP is admitted again. Version 5 scoped the udp/67 accept to the
 *    interface's own address, which no DHCPDISCOVER carries, so no new VM could
 *    take a lease; existing VMs were unaffected because renewal is unicast.
 */
export const GATEWAY_RENDER_VERSION = 6;

/**
 * Loopback-only forward-proxy port.
 *
 * Squid refuses to start with only intercepting ports: it needs a forward-proxy
 * port to build its internal URLs, and otherwise dies on
 * "cannot parse internal URL: http://<host>:0/...". Binding it to 127.0.0.1
 * satisfies that without offering lab VMs a proxy that would bypass the
 * per-subnet interception policy. Requests arriving here still fall through to
 * `http_access deny all`, because loopback is in no lab subnet.
 */
export const GATEWAY_INTERNAL_PROXY_PORT = 3130;

/** Squid's intercepting HTTP port. Lab TCP 80 is redirected here. */
export const GATEWAY_HTTP_PROXY_PORT = 3128;
/** Squid's intercepting HTTPS port. Lab TCP 443 is redirected here. */
export const GATEWAY_HTTPS_PROXY_PORT = 3129;
/** The only resolver lab VMs may reach. */
export const GATEWAY_DNS_PORT = 53;

export type GatewayAllowedDomain = {
    domain: string;
    include_subdomains: boolean;
};

export type GatewayGroupInput = {
    group_id: number;
    vlan_tag: number;
    subnet_cidr: string;
    allowed_web_domains: GatewayAllowedDomain[];
};

export type GatewayPeeringInput = {
    group_a_id: number;
    group_b_id: number;
};

export type GatewayDesiredStateInput = {
    groups: GatewayGroupInput[];
    peerings: GatewayPeeringInput[];
    /** Parent NIC attached to the VLAN-aware lab bridge. */
    trunk_interface: string;
    /** NIC used for approved egress. Never the lab trunk. */
    uplink_interface: string;
    /** NIC the orchestrator manages the Gateway through. */
    management_interface: string;
    /** Resolvers the Gateway itself may query through the uplink. */
    upstream_resolvers: string[];
    /** Sources permitted to reach Gateway management services. */
    management_source_cidrs: string[];
};

export type GatewayVlanInterface = {
    group_id: number;
    vlan_tag: number;
    interface_name: string;
    subnet_cidr: string;
    address_cidr: string;
    gateway_ip: string;
    netmask: string;
    dhcp_first: string;
    dhcp_last: string;
    allowed_web_domains: GatewayAllowedDomain[];
};

/**
 * One direction of an undirected peering.
 *
 * `ct state established,related` only readmits reply traffic, so a peering that
 * both sides may initiate requires an explicit entry per direction.
 */
export type GatewayPeeringEdge = {
    from_vlan_tag: number;
    to_vlan_tag: number;
    from_interface: string;
    to_interface: string;
};

export type GatewayDesiredState = {
    version: 1;
    render_version: number;
    ipv6_enabled: false;
    management: {
        interface: string;
        address_cidr: string;
        allowed_sources: string[];
    };
    uplink: {
        interface: string;
    };
    proxy: {
        internal_port: number;
        http_port: number;
        https_port: number;
    };
    dns: {
        port: number;
        upstream_resolvers: string[];
    };
    transport: {
        gateway_vmid: number;
        bridge: string;
        parent_interface: string;
        trunk_vlan_ids: number[];
        trunk_allowlist: string;
        interfaces: GatewayVlanInterface[];
    };
    peerings: GatewayPeeringEdge[];
};

export type GatewayPlan = {
    revision: string;
    desired_state: GatewayDesiredState;
};

// Linux interface names are capped at 15 characters. Restricting the character
// set also keeps rendered nftables and networkd files free of quoting hazards.
const INTERFACE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,14}$/;
const DOMAIN_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function parseIpv4Cidr(cidr: string, label: string): { address: string; prefix: number } {
    const [address, prefixText, extra] = cidr.split("/");
    const prefix = Number(prefixText);
    if (
        extra !== undefined
        || isIP(address) !== 4
        || !Number.isInteger(prefix)
        || prefix < 0
        || prefix > 32
    ) {
        throw new Error(`${label} must be a valid IPv4 CIDR`);
    }
    return { address, prefix };
}

function netmaskFromPrefix(prefix: number): string {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return [24, 16, 8, 0].map((shift) => (mask >>> shift) & 0xff).join(".");
}

function validateInterfaceName(name: string, label: string): string {
    if (!INTERFACE_NAME_PATTERN.test(name)) {
        throw new Error(`${label} is not a valid interface name`);
    }
    return name;
}

function canonicalCidrs(cidrs: string[], label: string): string[] {
    if (cidrs.length === 0) {
        throw new Error(`${label} must not be empty`);
    }
    return [...new Set(cidrs.map((cidr) => {
        parseIpv4Cidr(cidr, label);
        return cidr;
    }))].sort();
}

function canonicalResolvers(resolvers: string[]): string[] {
    if (resolvers.length === 0) {
        throw new Error("At least one upstream resolver is required");
    }
    for (const resolver of resolvers) {
        if (isIP(resolver) !== 4) {
            throw new Error(`Upstream resolver ${resolver} must be a literal IPv4 address`);
        }
    }
    return [...new Set(resolvers)].sort();
}

/**
 * Normalises an allowlist entry to a bare lower-case domain.
 *
 * Schemes, ports, paths, wildcards, and trailing dots are rejected rather than
 * stripped: silently reinterpreting an operator's entry could widen a policy
 * they believed was narrow.
 */
export function normaliseAllowedDomain(domain: string): string {
    const normalised = domain.trim().toLowerCase();
    if (normalised.length === 0 || normalised.length > 253) {
        throw new Error(`Allowed domain ${JSON.stringify(domain)} has an invalid length`);
    }
    if (/[:/\\*\s]/.test(normalised)) {
        throw new Error(
            `Allowed domain ${JSON.stringify(domain)} must not contain a scheme, port, path, wildcard, or whitespace`,
        );
    }
    if (normalised.endsWith(".") || normalised.startsWith(".")) {
        throw new Error(`Allowed domain ${JSON.stringify(domain)} must not have a leading or trailing dot`);
    }
    const labels = normalised.split(".");
    if (labels.length < 2) {
        throw new Error(`Allowed domain ${JSON.stringify(domain)} must be fully qualified`);
    }
    for (const label of labels) {
        if (!DOMAIN_LABEL_PATTERN.test(label)) {
            throw new Error(`Allowed domain ${JSON.stringify(domain)} has an invalid label`);
        }
    }
    if (/^[0-9]+$/.test(labels[labels.length - 1])) {
        throw new Error(`Allowed domain ${JSON.stringify(domain)} must not be an IP address`);
    }
    return normalised;
}

function canonicalDomains(
    domains: GatewayAllowedDomain[],
    groupId: number,
): GatewayAllowedDomain[] {
    const byDomain = new Map<string, boolean>();
    for (const entry of domains) {
        const domain = normaliseAllowedDomain(entry.domain);
        const existing = byDomain.get(domain);
        if (existing !== undefined && existing !== entry.include_subdomains) {
            throw new Error(
                `Group ${groupId} lists ${domain} with conflicting include_subdomains values`,
            );
        }
        byDomain.set(domain, entry.include_subdomains);
    }
    return [...byDomain.entries()]
        .map(([domain, include_subdomains]) => ({ domain, include_subdomains }))
        .sort((left, right) => left.domain.localeCompare(right.domain));
}

function buildInterface(
    group: GatewayGroupInput,
    trunkInterface: string,
    config: NetworkProjectionConfig,
): GatewayVlanInterface {
    if (group.vlan_tag < config.vlan.first || group.vlan_tag > config.vlan.last) {
        throw new Error(
            `Group ${group.group_id} VLAN ${group.vlan_tag} is outside the approved pool`,
        );
    }

    const { address, prefix } = parseIpv4Cidr(
        group.subnet_cidr,
        `Group ${group.group_id} subnet`,
    );
    const octets = address.split(".").map(Number);
    const expectedSubnetIndex = group.vlan_tag - config.vlan.first;
    if (
        prefix !== config.ipv4.groupPrefix
        || octets[0] !== 10
        || octets[1] !== 200
        || octets[2] !== expectedSubnetIndex
        || octets[3] !== 0
    ) {
        throw new Error(
            `Group ${group.group_id} subnet does not match VLAN ${group.vlan_tag}`,
        );
    }

    const prefixOctets = `${octets[0]}.${octets[1]}.${octets[2]}`;
    return {
        group_id: group.group_id,
        vlan_tag: group.vlan_tag,
        interface_name: `${trunkInterface}.${group.vlan_tag}`,
        subnet_cidr: group.subnet_cidr,
        address_cidr: `${prefixOctets}.${config.ipv4.gatewayHost}/${prefix}`,
        gateway_ip: `${prefixOctets}.${config.ipv4.gatewayHost}`,
        netmask: netmaskFromPrefix(prefix),
        dhcp_first: `${prefixOctets}.${config.ipv4.dhcpFirstHost}`,
        dhcp_last: `${prefixOctets}.${config.ipv4.dhcpLastHost}`,
        allowed_web_domains: canonicalDomains(group.allowed_web_domains, group.group_id),
    };
}

function buildPeeringEdges(
    peerings: GatewayPeeringInput[],
    interfacesByGroup: Map<number, GatewayVlanInterface>,
): GatewayPeeringEdge[] {
    const seen = new Set<string>();
    const edges: GatewayPeeringEdge[] = [];

    for (const peering of peerings) {
        if (peering.group_a_id === peering.group_b_id) {
            throw new Error(`Peering ${peering.group_a_id} references a single group twice`);
        }
        const [lowId, highId] = peering.group_a_id < peering.group_b_id
            ? [peering.group_a_id, peering.group_b_id]
            : [peering.group_b_id, peering.group_a_id];
        const key = `${lowId}:${highId}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const low = interfacesByGroup.get(lowId);
        const high = interfacesByGroup.get(highId);
        if (!low || !high) {
            throw new Error(
                `Peering ${lowId}-${highId} references a group without an active VLAN interface`,
            );
        }
        // Both directions, because established/related only readmits replies.
        edges.push({
            from_vlan_tag: low.vlan_tag,
            to_vlan_tag: high.vlan_tag,
            from_interface: low.interface_name,
            to_interface: high.interface_name,
        });
        edges.push({
            from_vlan_tag: high.vlan_tag,
            to_vlan_tag: low.vlan_tag,
            from_interface: high.interface_name,
            to_interface: low.interface_name,
        });
    }

    return edges.sort((left, right) => (
        left.from_vlan_tag - right.from_vlan_tag || left.to_vlan_tag - right.to_vlan_tag
    ));
}

export function buildGatewayPlan(
    input: GatewayDesiredStateInput,
    config: NetworkProjectionConfig = networkProjectionConfig,
): GatewayPlan {
    validateNetworkProjectionConfig(config);

    const trunkInterface = validateInterfaceName(input.trunk_interface, "Gateway trunk interface");
    const uplinkInterface = validateInterfaceName(input.uplink_interface, "Gateway uplink interface");
    const managementInterface = validateInterfaceName(
        input.management_interface,
        "Gateway management interface",
    );
    const distinct = new Set([trunkInterface, uplinkInterface, managementInterface]);
    if (distinct.size !== 3) {
        throw new Error("Gateway trunk, uplink, and management interfaces must be distinct");
    }

    const interfaces = input.groups
        .map((group) => buildInterface(group, trunkInterface, config))
        .sort((left, right) => left.vlan_tag - right.vlan_tag);

    const vlanIds = interfaces.map(({ vlan_tag }) => vlan_tag);
    if (new Set(vlanIds).size !== vlanIds.length) {
        throw new Error("Gateway groups contain duplicate VLAN allocations");
    }
    const subnetCidrs = interfaces.map(({ subnet_cidr }) => subnet_cidr);
    if (new Set(subnetCidrs).size !== subnetCidrs.length) {
        throw new Error("Gateway groups contain duplicate subnet allocations");
    }
    const groupIds = interfaces.map(({ group_id }) => group_id);
    if (new Set(groupIds).size !== groupIds.length) {
        throw new Error("Gateway groups contain duplicate group identifiers");
    }

    const interfacesByGroup = new Map(
        interfaces.map((entry) => [entry.group_id, entry]),
    );
    const peerings = buildPeeringEdges(input.peerings, interfacesByGroup);

    const desiredState: GatewayDesiredState = {
        version: 1,
        render_version: GATEWAY_RENDER_VERSION,
        ipv6_enabled: false,
        management: {
            interface: managementInterface,
            address_cidr: config.infrastructure.gatewayManagementCidr,
            allowed_sources: canonicalCidrs(
                input.management_source_cidrs,
                "Gateway management source",
            ),
        },
        uplink: { interface: uplinkInterface },
        proxy: {
            internal_port: GATEWAY_INTERNAL_PROXY_PORT,
            http_port: GATEWAY_HTTP_PROXY_PORT,
            https_port: GATEWAY_HTTPS_PROXY_PORT,
        },
        dns: {
            port: GATEWAY_DNS_PORT,
            upstream_resolvers: canonicalResolvers(input.upstream_resolvers),
        },
        transport: {
            gateway_vmid: config.proxmox.gatewayVmid,
            bridge: config.proxmox.bridge,
            parent_interface: trunkInterface,
            trunk_vlan_ids: vlanIds,
            trunk_allowlist: vlanIds.join(";"),
            interfaces,
        },
        peerings,
    };

    return {
        revision: createHash("sha256").update(JSON.stringify(desiredState)).digest("hex"),
        desired_state: desiredState,
    };
}
