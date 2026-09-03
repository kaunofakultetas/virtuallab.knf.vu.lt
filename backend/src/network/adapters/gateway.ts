// -----------------------------------------------------------
//  [*] Network adapters — Gateway: the observation channel
//
//  The schemas for what the Gateway forced observer returns
//  (host + guest halves), the SSH client that fetches it,
//  the renderer-to-guest path contract, and planGateway —
//  the grading of one observation against the Gateway plan.
//  All read-only: planGateway emits checks and no actions.
//
//  Used by:
//    - gateway-clients.ts — createGatewayObserver
//    - gateway-apply.ts, gateway-apply-runner.ts,
//      infrastructure-reconciler.ts, drift-reconciler.ts
//    - test/gateway-adapter.test.ts
// -----------------------------------------------------------

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { GatewayPlan } from "../gateway-desired-state";
import { renderGatewayConfiguration } from "../gateway-render";
import { networkProjectionConfig } from "../config";
import { ReconciliationCheck, ReconciliationDryRun } from "../reconciliation-types";
import { RestrictedSshTransport } from "./restricted-ssh";

// The Gateway guest reports digests of its managed files rather than their
// content, so drift detection never transports rendered policy over the
// observation channel. `null` means the file is genuinely absent; the observer
// raises rather than reporting `null` for a file it merely could not read.
export const gatewayGuestObservationSchema = z.object({
    version: z.literal(1),
    captured_at: z.string(),
    interfaces: z.array(z.object({
        name: z.string(),
        addresses: z.array(z.string()),
        parent: z.string().nullable().optional(),
        operstate: z.string(),
    })),
    vlan_interfaces: z.array(z.object({
        name: z.string(),
        vlan_id: z.number().int(),
        parent: z.string().nullable().optional(),
    })),
    default_routes: z.array(z.object({
        gateway: z.string(),
        interface: z.string(),
    })),
    nftables_revision: z.string().nullable(),
    managed_files: z.record(z.string(), z.string().nullable()),
    services: z.record(z.string(), z.object({
        active: z.boolean(),
        enabled: z.boolean(),
    })),
    listeners: z.array(z.object({
        protocol: z.enum(["tcp", "udp"]),
        address: z.string(),
        port: z.number().int(),
    })),
    sysctl: z.object({
        ipv4_forwarding: z.boolean(),
        ipv6_disabled: z.boolean(),
    }),
});

export const gatewayHostObservationSchema = z.object({
    version: z.literal(1),
    request_id: z.string(),
    target: z.literal("gateway"),
    operation: z.literal("observe"),
    captured_at: z.string(),
    vmid: z.number().int(),
    status: z.string(),
    config_digest: z.string(),
    network_devices: z.record(z.string(), z.object({
        bridge: z.string().nullable(),
        firewall: z.boolean(),
        connected: z.boolean(),
        trunks: z.array(z.number().int()),
    })),
    ip_config: z.record(z.string(), z.string()),
    guest: gatewayGuestObservationSchema,
    errors: z.array(z.string()),
});

export type GatewayHostObservation = z.infer<typeof gatewayHostObservationSchema>;

export interface GatewayObservationClient {
    observe(): Promise<GatewayHostObservation>;
}








// -----------------------------------------------------------
// RestrictedSshGatewayObservationClient
// -----------------------------------------------------------
//
// One observe call over the restricted transport, with the
// answer matched to the request that asked for it.
//
// Used by:
//   - gateway-clients.ts — createGatewayObserver
// -----------------------------------------------------------

export class RestrictedSshGatewayObservationClient implements GatewayObservationClient {
    constructor(private readonly transport: Pick<RestrictedSshTransport, "execute">) {}

    async observe(): Promise<GatewayHostObservation> {
        const requestId = randomUUID();
        const result = gatewayHostObservationSchema.parse(await this.transport.execute({
            version: 1,
            request_id: requestId,
            target: "gateway",
            operation: "observe",
        }));
        if (result.request_id !== requestId) {
            throw new Error("Gateway observer request ID does not match the request");
        }
        return result;
    }
}








// -----------------------------------------------------------
// renderedGatewayFiles
// -----------------------------------------------------------
//
// The rendered files, keyed by the absolute path they
// occupy on the guest.
//
// This mapping is the contract between the renderer and the
// observer: the observer digests exactly these paths. Keep
// it aligned with `renderGatewayConfiguration`'s bundle
// writer and with `MANAGED_PATHS` in
// `infra/gateway/observe_gateway.py`.
//
// Used by:
//   - gateway-apply.ts — the stage request
//   - planGateway (below) — the digest comparison
// -----------------------------------------------------------

export function renderedGatewayFiles(plan: GatewayPlan): Record<string, string> {
    const rendered = renderGatewayConfiguration(plan);
    return {
        ...rendered.files.networkd,
        "/etc/sysctl.d/99-virtual-lab-gateway.conf": rendered.files.sysctl,
        "/etc/nftables.d/virtual-lab-gateway.nft": rendered.files.nftables,
        "/etc/dnsmasq.d/virtual-lab-gateway.conf": rendered.files.dnsmasq,
        "/etc/squid/squid.conf": rendered.files.squid,
    };
}


function digest(content: string): string {
    return createHash("sha256").update(content).digest("hex");
}


function sameValues(left: number[], right: number[]): boolean {
    const canonical = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
    return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}


const REQUIRED_SERVICES = ["nftables", "dnsmasq", "squid"] as const;








// -----------------------------------------------------------
// planGateway
// -----------------------------------------------------------
//
// Compares a Gateway observation against desired state.
//
// Every check is deterministic and read-only. Nothing here
// proposes an action: a failing check reports drift for the
// apply runners and the drift sweep to act on. The inline
// comments carry each check's reasoning — the trunk carries
// the whole approved pool, the VLAN check compares names
// AND addresses, the nftables revision is read from the
// running ruleset, and so on.
//
// Used by:
//   - gateway-apply.ts, gateway-apply-runner.ts,
//     infrastructure-reconciler.ts, drift-reconciler.ts
// -----------------------------------------------------------

export function planGateway(
    gatewayPlan: GatewayPlan,
    input: unknown,
    config = networkProjectionConfig,
): ReconciliationDryRun {
    const observation = gatewayHostObservationSchema.parse(input);
    const desired = gatewayPlan.desired_state;
    const guest = observation.guest;
    const checks: ReconciliationCheck[] = [];
    const add = (
        key: string,
        status: ReconciliationCheck["status"],
        detail: string,
        required = true,
    ) => checks.push({ key, component: "gateway", status, required, detail });

    add(
        "gateway-observer-errors",
        observation.errors.length === 0 ? "pass" : "fail",
        observation.errors.length === 0
            ? "Gateway observer completed without errors"
            : `${observation.errors.length} Gateway observer error(s) reported`,
    );

    add(
        "gateway-vm-status",
        observation.status === "running" ? "pass" : "fail",
        `Gateway VM ${observation.vmid} status: ${observation.status}`,
    );

    // Persistent NIC topology. The trunk carries the whole approved VLAN pool
    // rather than only allocated tags, because Proxmox applies a trunk list to
    // a stopped NIC only; narrowing it per allocation would force a shutdown.
    const approvedVlans = Array.from(
        { length: config.vlan.last - config.vlan.first + 1 },
        (_unused, index) => config.vlan.first + index,
    );
    const trunk = observation.network_devices.net1;
    add(
        "gateway-trunk-topology",
        trunk && trunk.bridge === config.proxmox.bridge && sameValues(trunk.trunks, approvedVlans)
            ? "pass"
            : "fail",
        trunk
            ? `net1 bridge=${trunk.bridge}, ${trunk.trunks.length} trunk VLAN(s)`
            : "net1 is absent",
    );

    const uplink = observation.network_devices.net2;
    add(
        "gateway-uplink-connected",
        uplink && uplink.connected ? "pass" : "fail",
        uplink
            ? `net2 bridge=${uplink.bridge}, connected=${uplink.connected}`
            : "net2 is absent",
    );

    // The guest must hold exactly one default route, and it must leave by the
    // uplink. Two default routes would make approved egress non-deterministic.
    const defaultRoutes = guest.default_routes;
    add(
        "gateway-default-route",
        defaultRoutes.length === 1 && defaultRoutes[0].interface === desired.uplink.interface
            ? "pass"
            : "fail",
        defaultRoutes.length === 0
            ? "No default route"
            : defaultRoutes.map((route) => `${route.gateway} dev ${route.interface}`).join(", "),
    );

    const managementInterface = guest.interfaces.find(
        (entry) => entry.name === desired.management.interface,
    );
    add(
        "gateway-management-address",
        managementInterface?.addresses.includes(desired.management.address_cidr) ? "pass" : "fail",
        managementInterface
            ? `${managementInterface.name} addresses: ${managementInterface.addresses.join(", ") || "none"}`
            : `${desired.management.interface} is absent`,
    );

    // Desired VLAN subinterfaces, by name AND address. With no allocated group
    // this asserts that none exist, which is what caught stale interfaces on
    // Access.
    //
    // The address is checked because it is hashed into the revision and is what
    // every group's traffic actually depends on: comparing names alone let an
    // interface that exists but holds no address -- networkd creating the netdev
    // while the matching .network fails, or someone running `ip addr del` --
    // read as fully converged. Every file digest still matched, the nftables
    // revision still matched, and the group was simply unreachable.
    const addressesByInterface = new Map(
        guest.interfaces.map(({ name, addresses }) => [name, addresses]),
    );
    const describe = (name: string, addressCidr: string | undefined) => (
        addressCidr ? `${name}=${addressCidr}` : name
    );
    const sortedDesired = desired.transport.interfaces
        .map(({ interface_name, address_cidr }) => describe(interface_name, address_cidr))
        .sort();
    const sortedObserved = guest.vlan_interfaces
        .map(({ name }) => {
            const held = addressesByInterface.get(name) ?? [];
            const wanted = desired.transport.interfaces
                .find(({ interface_name }) => interface_name === name)?.address_cidr;
            // Report the desired address when the interface holds it, so an
            // interface carrying extra addresses is not spurious drift, and the
            // absence of the desired one is.
            return describe(name, wanted && held.includes(wanted) ? wanted : held[0]);
        })
        .sort();
    add(
        "gateway-vlan-interfaces",
        JSON.stringify(sortedDesired) === JSON.stringify(sortedObserved) ? "pass" : "fail",
        `expected [${sortedDesired.join(", ")}], observed [${sortedObserved.join(", ")}]`,
    );

    // The running ruleset's own revision, not the file's. A correct file can sit
    // beside a kernel running something else entirely.
    add(
        "gateway-nftables-revision",
        guest.nftables_revision === gatewayPlan.revision ? "pass" : "fail",
        guest.nftables_revision === null
            ? "No managed nftables table is loaded"
            : guest.nftables_revision === gatewayPlan.revision
                ? `nftables ruleset matches revision ${gatewayPlan.revision}`
                : `nftables ruleset reports ${guest.nftables_revision}, expected ${gatewayPlan.revision}`,
    );

    // Per-file digests. The revision alone cannot distinguish "never applied"
    // from "applied, then edited by hand".
    const expectedFiles = renderedGatewayFiles(gatewayPlan);
    const mismatched = Object.entries(expectedFiles)
        .filter(([path, content]) => guest.managed_files[path] !== digest(content))
        .map(([path]) => path);
    const unexpected = Object.entries(guest.managed_files)
        .filter(([path, observed]) => observed !== null && !(path in expectedFiles))
        .map(([path]) => path);
    add(
        "gateway-managed-files",
        mismatched.length === 0 && unexpected.length === 0 ? "pass" : "fail",
        mismatched.length === 0 && unexpected.length === 0
            ? `${Object.keys(expectedFiles).length} managed file(s) match the rendered configuration`
            : [
                mismatched.length ? `differ or absent: ${mismatched.join(", ")}` : "",
                unexpected.length ? `present but not desired: ${unexpected.join(", ")}` : "",
            ].filter(Boolean).join("; "),
    );

    const inactive = REQUIRED_SERVICES.filter((service) => !guest.services[service]?.active);
    const notEnabled = REQUIRED_SERVICES.filter((service) => !guest.services[service]?.enabled);
    add(
        "gateway-services",
        inactive.length === 0 && notEnabled.length === 0 ? "pass" : "fail",
        inactive.length === 0 && notEnabled.length === 0
            ? `${REQUIRED_SERVICES.join(", ")} are active and enabled`
            : [
                inactive.length ? `inactive: ${inactive.join(", ")}` : "",
                notEnabled.length ? `not enabled at boot: ${notEnabled.join(", ")}` : "",
            ].filter(Boolean).join("; "),
    );

    // dnsmasq must never answer on anything but loopback while no lab VLAN
    // exists. Binding the uplink would put a rogue DHCP server on a university
    // network, so this stays a required check rather than an advisory one.
    const dnsListeners = guest.listeners.filter(
        (listener) => listener.port === desired.dns.port,
    );
    const offLoopback = dnsListeners.filter(
        (listener) => !listener.address.startsWith("127.") && listener.address !== "::1",
    );
    const desiredDnsAddresses = desired.transport.interfaces.map(
        ({ gateway_ip }) => gateway_ip,
    );
    const strayDns = offLoopback.filter(
        (listener) => !desiredDnsAddresses.includes(listener.address),
    );
    add(
        "gateway-dns-binding",
        strayDns.length === 0 ? "pass" : "fail",
        strayDns.length === 0
            ? `DNS listens only on loopback and ${desiredDnsAddresses.length} lab gateway address(es)`
            : `DNS unexpectedly bound to ${strayDns.map((listener) => listener.address).join(", ")}`,
    );

    add(
        "gateway-sysctl",
        guest.sysctl.ipv4_forwarding && guest.sysctl.ipv6_disabled ? "pass" : "fail",
        `ipv4_forwarding=${guest.sysctl.ipv4_forwarding}, ipv6_disabled=${guest.sysctl.ipv6_disabled}`,
    );

    return { checks, actions: [] };
}
