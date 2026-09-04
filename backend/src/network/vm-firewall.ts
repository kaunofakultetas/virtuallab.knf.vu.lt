// -----------------------------------------------------------
//  [*] Network — rendering one student VM's firewall policy
//
//  This is the only place same-segment policy can be
//  enforced. Traffic between VMs on one VLAN is switched at
//  layer 2 and never reaches the Gateway, so the Gateway's
//  ruleset — where every other network control lives —
//  cannot see it at all. Student-to-student isolation,
//  rogue-DHCP suppression and source-address spoofing are
//  enforced here or nowhere.
//
//  Pure rendering: no Proxmox calls. The policy's revision
//  hashes the rendered document (plus a render version, so
//  a semantics change can force re-application).
//
//  Used by:
//    - provisioning-firewall.ts — at VM creation
//    - drift-reconciler.ts — the firewall sweep
//    - test/vm-firewall.test.ts
// -----------------------------------------------------------

import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { ConnectionType, ConnectionConfig } from "@/types/templates";
import { ProxmoxFirewallOptionsUpdate, ProxmoxFirewallRuleInput } from "@/proxmox/types";

// Version of the rendered firewall's semantics. The revision hashes the desired
// document, so a change to this renderer alone would otherwise produce an
// identical revision and a VM still carrying the previous rules would look
// converged. Bump whenever the meaning of the rendered policy changes.
export const VM_FIREWALL_RENDER_VERSION = 1;

// Proxmox reads this IPSet as the set of source addresses the guest is allowed
// to send from. The `net0` suffix is the NIC index, and student VMs are
// provisioned with exactly one NIC.
export const VM_FIREWALL_IPSET = "ipfilter-net0";

export class VmFirewallError extends Error {}

export type VmFirewallInput = {
    // Proxmox VMID, as a string, matching `instances.proxmox_id`.
    vmid: string;
    // The group's subnet, which bounds every address the VM may claim.
    subnet_cidr: string;
    // Reserved infrastructure addresses inside that subnet, `.1` and `.2`.
    gateway_ip: string;
    access_ip: string;
    // TCP ports the Access appliance may open a session on.
    session_ports: number[];
    // Subnets of explicitly peered groups. Empty unless a peering exists.
    peer_subnet_cidrs: string[];
    // The owning profile's `lab_profiles.allow_same_group`. True admits the
    // group's own subnet on every port and protocol. A group is one owner on one
    // profile, so this is one student's VMs reaching each other, never two
    // students'.
    //
    // Deliberately NOT expressed through `peer_subnet_cidrs`: that list is the
    // `group_peerings` table, and pushing the group's own subnet into it would
    // trip the self-peering guard below. Deliberately not a pre-resolved CIDR
    // either — `subnet_cidr` above is already the group's own subnet, and a
    // second field carrying it could disagree and open a foreign /24.
    //
    // Required, with no default: the two call sites that render this policy —
    // provisioning and the drift reconciler — must agree, or the ten-minute
    // sweep rewrites whatever provisioning just wrote, forever. A compile error
    // is the only reliable guard against forgetting one.
    allow_same_group: boolean;
};

export type VmFirewallIpSetEntry = {
    cidr: string;
    // True marks an exclusion from an enclosing range, not a separate match.
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
    // In Proxmox evaluation order: first match wins, then the policy applies.
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








// -----------------------------------------------------------
// sessionPortsForTemplate
// -----------------------------------------------------------
//
// The TCP ports the Access appliance opens a session on,
// derived from the template rather than assumed.
//
// Guessing a superset here would widen the one ingress a
// student VM has. The ports mirror what
// `POST /instances/:instanceId/session` actually dials: RDP
// for a Guacamole template, the configured SSH port, or the
// configured web port.
//
// A null connection type means the template row is gone and
// is REFUSED, not defaulted. Defaulting it to Guacamole
// rewrote every affected VM's one ingress rule to RDP/3389;
// throwing makes the reconciler report the VM as unreadable
// and change nothing.
//
// Used by:
//   - provisioning-firewall.ts, drift-reconciler.ts
// -----------------------------------------------------------

export function sessionPortsForTemplate(
    connectionType: ConnectionType | null | undefined,
    connectionConfig: ConnectionConfig | null | undefined,
): number[] {
    const config = (connectionConfig ?? {}) as Record<string, unknown>;
    const configured = typeof config.port === "number" ? config.port : undefined;
    // Switched on bare, with no `?? "guacamole"` default — that fallback made
    // the `default:` branch below unreachable, which is why it never fired.
    switch (connectionType) {
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








// -----------------------------------------------------------
// buildVmFirewallPolicy
// -----------------------------------------------------------
//
// Builds the Proxmox firewall policy for one student VM.
//
// Ingress is default-deny. The exceptions, in the order
// Proxmox evaluates them because first match wins: the
// Access appliance on the template's session ports, ICMP
// from the two infrastructure addresses, then — only when
// the group's profile sets `allow_same_group` — the
// Gateway's DHCP reply, a DROP for each of the two
// infrastructure addresses, and finally the group's own
// subnet on every port and protocol. Those two DROPs are
// load-bearing: `.1` and `.2` are inside the subnet, so
// without them the final ACCEPT would silently widen Access
// from its session ports to everything. Explicitly peered
// groups come last.
//
// Egress stays default-allow, because the Gateway's
// nftables is the single source of truth for what a VM may
// reach off-segment; duplicating it here would create two
// policies that drift. The egress rules below are only the
// ones the Gateway structurally cannot enforce, because the
// traffic never reaches it.
//
// Used by:
//   - provisioning-firewall.ts, drift-reconciler.ts
// -----------------------------------------------------------

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
        // Same-group reachability, when the group's profile allows it. ORDER IS
        // THE SECURITY PROPERTY HERE. `.1` and `.2` live inside the subnet and
        // Proxmox stops at the first match, so the broad ACCEPT at the bottom of
        // this block would otherwise hand Access every port instead of the
        // session ports, and the Gateway every protocol instead of ICMP. The two
        // DROPs are what stops it, and they only work above it. Nothing else in
        // this list is an ingress DROP, so there is no second line of defence.
        ...(input.allow_same_group ? [
            // Pinned above the DROPs because a DROP from `.1` would otherwise
            // stop every VM renewing its lease. This grants nothing new: ipfilter
            // already forbids a guest from claiming `.1`.
            {
                type: "in" as const,
                action: "ACCEPT",
                source: gatewayIp,
                proto: "udp",
                sport: "67",
                dport: "68",
                enable: true,
                comment: "virtual-lab: the Gateway's DHCP reply, ahead of the drops below",
            },
            {
                type: "in" as const,
                action: "DROP",
                source: gatewayIp,
                enable: true,
                comment: "virtual-lab: the Gateway reaches no further than ICMP",
            },
            {
                type: "in" as const,
                action: "DROP",
                source: accessIp,
                enable: true,
                comment: "virtual-lab: Access reaches no further than the session ports",
            },
            // No proto, no dport, no sport: an omitted protocol is what makes this
            // cover tcp, udp and icmp in one rule, and a port without a protocol
            // makes pve-firewall refuse the ruleset outright.
            {
                type: "in" as const,
                action: "ACCEPT",
                source: subnet,
                enable: true,
                comment: "virtual-lab: same network group, every port and protocol",
            },
        ] : []),
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
