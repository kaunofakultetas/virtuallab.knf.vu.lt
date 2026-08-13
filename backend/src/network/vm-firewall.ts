import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { ConnectionType, ConnectionConfig } from "@/types/templates";
import { ProxmoxFirewallOptionsUpdate, ProxmoxFirewallRuleInput } from "@/proxmox/types";

/**
 * Version of the rendered firewall's semantics. The revision hashes the desired
 * document, so a change to this renderer alone would otherwise produce an
 * identical revision and a VM still carrying the previous rules would look
 * converged. Bump whenever the meaning of the rendered policy changes.
 */
export const VM_FIREWALL_RENDER_VERSION = 1;

/**
 * Proxmox reads this IPSet as the set of source addresses the guest is allowed
 * to send from. The `net0` suffix is the NIC index, and student VMs are
 * provisioned with exactly one NIC.
 */
export const VM_FIREWALL_IPSET = "ipfilter-net0";

export class VmFirewallError extends Error {}

export type VmFirewallInput = {
    /** Proxmox VMID, as a string, matching `instances.proxmox_id`. */
    vmid: string;
    /** The group's subnet, which bounds every address the VM may claim. */
    subnet_cidr: string;
    /** Reserved infrastructure addresses inside that subnet, `.1` and `.2`. */
    gateway_ip: string;
    access_ip: string;
    /** TCP ports the Access appliance may open a session on. */
    session_ports: number[];
    /** Subnets of explicitly peered groups. Empty unless a peering exists. */
    peer_subnet_cidrs: string[];
};

export type VmFirewallIpSetEntry = {
    cidr: string;
    /** True marks an exclusion from an enclosing range, not a separate match. */
    nomatch: boolean;
    comment: string;
};

export type VmFirewallPolicy = {
    revision: string;
    vmid: string;
    options: Required<Pick<
        ProxmoxFirewallOptionsUpdate,
        "enable" | "dhcp" | "ipfilter" | "macfilter" | "ndp" | "radv" | "policy_in" | "policy_out"
    >>;
    ipset: VmFirewallIpSetEntry[];
    /** In Proxmox evaluation order: first match wins, then the policy applies. */
    rules: ProxmoxFirewallRuleInput[];
};

function requireIpv4(value: string, field: string): string {
    if (isIP(value) !== 4) {
        throw new VmFirewallError(`${field} must be an IPv4 address, received ${value}`);
    }
    return value;
}

function requireIpv4Cidr(value: string, field: string): string {
    const [address, prefixText, extra] = value.split("/");
    if (extra !== undefined || isIP(address ?? "") !== 4 || !/^\d{1,2}$/.test(prefixText ?? "")) {
        throw new VmFirewallError(`${field} must be an IPv4 CIDR, received ${value}`);
    }
    const prefix = Number(prefixText);
    // A prefix wider than /8 would hand the VM most of the address space to
    // spoof from, which defeats the point of the filter.
    if (prefix < 8 || prefix > 32) {
        throw new VmFirewallError(`${field} prefix is outside 8-32: ${value}`);
    }
    return value;
}

function requirePort(port: number): number {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new VmFirewallError(`Session port must be 1-65535, received ${port}`);
    }
    return port;
}

/**
 * The TCP ports the Access appliance opens a session on, derived from the
 * template rather than assumed.
 *
 * Guessing a superset here would widen the one ingress a student VM has. The
 * ports mirror what `POST /instances/:id/connection` actually dials: RDP for a
 * Guacamole template, the configured SSH port, or the configured web port.
 */
export function sessionPortsForTemplate(
    connectionType: ConnectionType | null | undefined,
    connectionConfig: ConnectionConfig | null | undefined,
): number[] {
    const config = (connectionConfig ?? {}) as Record<string, unknown>;
    const configured = typeof config.port === "number" ? config.port : undefined;
    switch (connectionType ?? "guacamole") {
        case "guacamole":
            return [3389];
        case "ssh":
            return [requirePort(configured ?? 22)];
        case "web":
            return [requirePort(configured ?? 80)];
        default:
            throw new VmFirewallError(`Unsupported connection type: ${String(connectionType)}`);
    }
}

/**
 * Builds the Proxmox firewall policy for one student VM.
 *
 * This is the only place same-segment policy can be enforced. Traffic between
 * VMs on one VLAN is switched at layer 2 and never reaches the Gateway, so the
 * Gateway's ruleset — which is where every other network control lives — cannot
 * see it at all. Student-to-student isolation, rogue DHCP suppression, and
 * source-address spoofing are therefore enforced here or nowhere.
 *
 * Ingress is default-deny with three exceptions: the Access appliance on the
 * template's session ports, ICMP from the two infrastructure addresses for
 * diagnostics and path-MTU discovery, and any explicitly peered group.
 *
 * Egress stays default-allow, because the Gateway's nftables is the single
 * source of truth for what a VM may reach off-segment; duplicating it here would
 * create two policies that drift. The egress rules below are only the ones the
 * Gateway structurally cannot enforce, because the traffic never reaches it.
 */
export function buildVmFirewallPolicy(input: VmFirewallInput): VmFirewallPolicy {
    const subnet = requireIpv4Cidr(input.subnet_cidr, "subnet_cidr");
    const gatewayIp = requireIpv4(input.gateway_ip, "gateway_ip");
    const accessIp = requireIpv4(input.access_ip, "access_ip");
    if (gatewayIp === accessIp) {
        throw new VmFirewallError("Gateway and Access addresses must differ");
    }
    if (input.session_ports.length === 0) {
        throw new VmFirewallError("A VM with no session port would be unreachable by Access");
    }
    const ports = [...new Set(input.session_ports.map(requirePort))].sort((a, b) => a - b);
    const peers = [...new Set(input.peer_subnet_cidrs)]
        .map((cidr) => requireIpv4Cidr(cidr, "peer_subnet_cidrs"))
        .sort();
    if (peers.includes(subnet)) {
        throw new VmFirewallError("A group cannot be peered with itself");
    }

    const options: VmFirewallPolicy["options"] = {
        enable: true,
        // The VM must be able to take a lease. Proxmox's own DHCP allowance is
        // client-scoped (it permits a request out and a reply in), which is why
        // the rogue-server rule below still bites.
        dhcp: true,
        // Enforced against the IPSet below. Without it a VM could claim the
        // Access address and reach a neighbour's session port.
        ipfilter: true,
        macfilter: true,
        // IPv6 must not become an unfiltered bypass. With neighbour discovery
        // and router advertisements both refused, IPv6 cannot establish on the
        // segment at all, and inbound IPv6 is covered by the DROP policy.
        ndp: false,
        radv: false,
        policy_in: "DROP",
        policy_out: "ACCEPT",
    };

    // Anything in the group's own subnet EXCEPT the two infrastructure
    // addresses. Those are excluded precisely because they are the sources the
    // ingress rules trust: a VM allowed to source from .2 could open a session
    // to a neighbour's RDP port, which is the isolation this whole file exists
    // to provide.
    //
    // Host addresses carry no `/32`: Proxmox stores a single address bare and
    // reports it back that way, so emitting the suffix would make every
    // observation read as drift and every delete miss its target.
    const ipset: VmFirewallIpSetEntry[] = [
        { cidr: subnet, nomatch: false, comment: "virtual-lab: the group's own subnet" },
        { cidr: gatewayIp, nomatch: true, comment: "virtual-lab: never the Gateway" },
        { cidr: accessIp, nomatch: true, comment: "virtual-lab: never Access" },
    ];

    const rules: ProxmoxFirewallRuleInput[] = [
        {
            type: "in",
            action: "ACCEPT",
            source: accessIp,
            proto: "tcp",
            dport: ports.join(","),
            enable: true,
            comment: "virtual-lab: session ports, from the Access appliance only",
        },
        {
            type: "in",
            action: "ACCEPT",
            source: gatewayIp,
            proto: "icmp",
            enable: true,
            comment: "virtual-lab: diagnostics and path-MTU discovery from the Gateway",
        },
        {
            type: "in",
            action: "ACCEPT",
            source: accessIp,
            proto: "icmp",
            enable: true,
            comment: "virtual-lab: diagnostics from the Access appliance",
        },
        ...peers.map((cidr) => ({
            type: "in" as const,
            action: "ACCEPT",
            source: cidr,
            enable: true,
            comment: `virtual-lab: peered group ${cidr}`,
        })),
        // A DHCP server answers from port 67 to the client's port 68. A client
        // never sends to port 68, so this cannot catch legitimate traffic. The
        // Gateway cannot enforce this: a rogue reply is switched straight to its
        // victim and never crosses a routed hop.
        {
            type: "out",
            action: "DROP",
            proto: "udp",
            dport: "68",
            enable: true,
            comment: "virtual-lab: a lab VM must never answer DHCP",
        },
        {
            type: "out",
            action: "DROP",
            proto: "udp",
            sport: "67",
            enable: true,
            comment: "virtual-lab: nor relay it",
        },
        // Access may initiate into the lab subnet; the lab may not initiate into
        // Access. Replies to an Access-initiated session are unaffected, because
        // Proxmox evaluates conntrack before these rules.
        {
            type: "out",
            action: "DROP",
            dest: accessIp,
            enable: true,
            comment: "virtual-lab: no VM-initiated connections into Access",
        },
    ];

    const document = {
        version: VM_FIREWALL_RENDER_VERSION,
        vmid: input.vmid,
        options,
        ipset,
        rules,
    };
    return {
        revision: createHash("sha256").update(JSON.stringify(document)).digest("hex"),
        vmid: input.vmid,
        options,
        ipset,
        rules,
    };
}
