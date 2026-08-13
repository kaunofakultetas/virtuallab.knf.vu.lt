import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
    buildGatewayPlan,
    GatewayDesiredStateInput,
    GatewayPlan,
} from "../src/network/gateway-desired-state";
import {
    planGateway,
    renderedGatewayFiles,
    RestrictedSshGatewayObservationClient,
} from "../src/network/adapters/gateway";
import { networkProjectionConfig } from "../src/network/config";

function baseInput(overrides: Partial<GatewayDesiredStateInput> = {}): GatewayDesiredStateInput {
    return {
        groups: [],
        peerings: [],
        trunk_interface: "ens19",
        uplink_interface: "eth2",
        management_interface: "eth0",
        upstream_resolvers: ["1.1.1.1"],
        management_source_cidrs: ["10.10.10.1/32", "10.10.10.100/32"],
        ...overrides,
    };
}

function group(vlanTag: number, groupId = vlanTag - 1999) {
    return {
        group_id: groupId,
        vlan_tag: vlanTag,
        subnet_cidr: `10.200.${vlanTag - 2000}.0/24`,
        allowed_web_domains: [],
    };
}

const APPROVED_VLANS = Array.from(
    { length: networkProjectionConfig.vlan.last - networkProjectionConfig.vlan.first + 1 },
    (_unused, index) => networkProjectionConfig.vlan.first + index,
);

/** An observation that matches the plan in every respect. */
function matchingObservation(plan: GatewayPlan): Record<string, unknown> {
    const desired = plan.desired_state;
    const files = renderedGatewayFiles(plan);
    return {
        version: 1,
        request_id: "00000000-0000-4000-8000-000000000000",
        target: "gateway",
        operation: "observe",
        captured_at: "2026-08-12T00:00:00Z",
        vmid: 202,
        status: "running",
        config_digest: "a".repeat(40),
        network_devices: {
            net0: { bridge: "vmbr1", firewall: true, connected: true, trunks: [] },
            net1: { bridge: "vmbr20", firewall: true, connected: true, trunks: APPROVED_VLANS },
            net2: { bridge: "vmbr0", firewall: true, connected: true, trunks: [] },
        },
        ip_config: {
            ipconfig0: "ip=10.10.10.2/24",
            ipconfig2: "gw=172.16.0.1,ip=172.16.0.36/22",
        },
        guest: {
            version: 1,
            captured_at: "2026-08-12T00:00:00Z",
            interfaces: [
                { name: desired.management.interface, addresses: [desired.management.address_cidr], parent: null, operstate: "UP" },
                { name: desired.uplink.interface, addresses: ["172.16.0.36/22"], parent: null, operstate: "UP" },
                { name: desired.transport.parent_interface, addresses: [], parent: null, operstate: "DOWN" },
                ...desired.transport.interfaces.map(({ interface_name, gateway_ip, subnet_cidr }) => ({
                    name: interface_name,
                    addresses: [`${gateway_ip}/${subnet_cidr.split("/")[1]}`],
                    parent: desired.transport.parent_interface,
                    operstate: "UP",
                })),
            ],
            vlan_interfaces: desired.transport.interfaces.map(({ interface_name, vlan_tag }) => ({
                name: interface_name,
                vlan_id: vlan_tag,
                parent: desired.transport.parent_interface,
            })),
            default_routes: [{ gateway: "172.16.0.1", interface: desired.uplink.interface }],
            nftables_revision: plan.revision,
            managed_files: Object.fromEntries(
                Object.entries(files).map(([path, content]) => [
                    path,
                    createHash("sha256").update(content).digest("hex"),
                ]),
            ),
            services: {
                nftables: { active: true, enabled: true },
                dnsmasq: { active: true, enabled: true },
                squid: { active: true, enabled: true },
            },
            listeners: [
                { protocol: "tcp", address: "0.0.0.0", port: 22 },
                { protocol: "udp", address: "127.0.0.1", port: 53 },
                { protocol: "tcp", address: "0.0.0.0", port: 3128 },
            ],
            sysctl: { ipv4_forwarding: true, ipv6_disabled: true },
        },
        errors: [],
    };
}

function failures(plan: GatewayPlan, observation: unknown): string[] {
    return planGateway(plan, observation)
        .checks.filter((check) => check.status !== "pass")
        .map((check) => check.key);
}

function detailOf(plan: GatewayPlan, observation: unknown, key: string): string {
    const check = planGateway(plan, observation).checks.find((entry) => entry.key === key);
    assert.ok(check, `expected a ${key} check`);
    return check.detail;
}

test("a fully converged Gateway produces no failing checks", () => {
    const plan = buildGatewayPlan(baseInput());
    assert.deepEqual(failures(plan, matchingObservation(plan)), []);
});

test("converged checks also pass with allocated groups and VLAN subinterfaces", () => {
    const plan = buildGatewayPlan(baseInput({ groups: [group(2000), group(2001)] }));
    assert.deepEqual(failures(plan, matchingObservation(plan)), []);
});

test("proposes no actions, because no Gateway applier exists yet", () => {
    const plan = buildGatewayPlan(baseInput());
    assert.deepEqual(planGateway(plan, matchingObservation(plan)).actions, []);
});

test("every check is reported against the gateway component", () => {
    const plan = buildGatewayPlan(baseInput());
    const { checks } = planGateway(plan, matchingObservation(plan));
    assert.ok(checks.length > 0);
    assert.ok(checks.every((check) => check.component === "gateway"));
});

test("a ruleset from an older renderer fails even when the files match", () => {
    // The exact case seen live: policy rendered before GATEWAY_RENDER_VERSION was
    // bumped produced identical output but a different revision.
    const plan = buildGatewayPlan(baseInput());
    const observation = matchingObservation(plan);
    (observation.guest as Record<string, unknown>).nftables_revision = "b".repeat(64);

    assert.deepEqual(failures(plan, observation), ["gateway-nftables-revision"]);
    assert.match(detailOf(plan, observation, "gateway-nftables-revision"), /expected/);
});

test("an absent managed table is reported distinctly from a mismatched one", () => {
    const plan = buildGatewayPlan(baseInput());
    const observation = matchingObservation(plan);
    (observation.guest as Record<string, unknown>).nftables_revision = null;

    assert.deepEqual(failures(plan, observation), ["gateway-nftables-revision"]);
    assert.match(
        detailOf(plan, observation, "gateway-nftables-revision"),
        /No managed nftables table is loaded/,
    );
});

test("a hand-edited managed file is caught even when the revision still matches", () => {
    const plan = buildGatewayPlan(baseInput());
    const observation = matchingObservation(plan);
    const guest = observation.guest as { managed_files: Record<string, string | null> };
    guest.managed_files["/etc/squid/squid.conf"] = "c".repeat(64);

    assert.deepEqual(failures(plan, observation), ["gateway-managed-files"]);
    assert.match(detailOf(plan, observation, "gateway-managed-files"), /squid\.conf/);
});

test("a managed file that is absent entirely is caught", () => {
    const plan = buildGatewayPlan(baseInput());
    const observation = matchingObservation(plan);
    const guest = observation.guest as { managed_files: Record<string, string | null> };
    guest.managed_files["/etc/dnsmasq.d/virtual-lab-gateway.conf"] = null;

    assert.deepEqual(failures(plan, observation), ["gateway-managed-files"]);
});

test("a managed file left behind by a previous desired state is caught", () => {
    // Rendering emits nothing for a removed VLAN, so an applier that only writes
    // files would leave this behind forever. The check must see it.
    const plan = buildGatewayPlan(baseInput());
    const observation = matchingObservation(plan);
    const guest = observation.guest as { managed_files: Record<string, string | null> };
    guest.managed_files["/etc/systemd/network/50-lab2000.network"] = "d".repeat(64);

    assert.deepEqual(failures(plan, observation), ["gateway-managed-files"]);
    assert.match(detailOf(plan, observation, "gateway-managed-files"), /present but not desired/);
});

test("a stale VLAN subinterface is caught when desired state has no groups", () => {
    const plan = buildGatewayPlan(baseInput());
    const observation = matchingObservation(plan);
    (observation.guest as Record<string, unknown>).vlan_interfaces = [
        { name: "lab2000", vlan_id: 2000, parent: "ens19" },
    ];

    assert.deepEqual(failures(plan, observation), ["gateway-vlan-interfaces"]);
    assert.match(detailOf(plan, observation, "gateway-vlan-interfaces"), /expected \[\], observed/);
});

test("a VLAN interface that exists but lost its address is drift, not convergence", () => {
    // The address is hashed into the revision and is what the group's traffic
    // actually depends on. Comparing names alone let `ip addr del` -- or
    // networkd creating the netdev while the matching .network failed -- read as
    // fully converged: every file digest still matched and the nftables revision
    // still matched, while the group was simply unreachable.
    const plan = buildGatewayPlan(baseInput({ groups: [group(2000)] }));
    const observation = matchingObservation(plan);
    const guest = observation.guest as { interfaces: Array<{ name: string; addresses: string[] }> };
    const vlan = guest.interfaces.find(({ name }) => name === "ens19.2000");
    assert.ok(vlan, "fixture must carry the VLAN interface");
    vlan.addresses = [];

    assert.deepEqual(failures(plan, observation), ["gateway-vlan-interfaces"]);
    assert.match(
        detailOf(plan, observation, "gateway-vlan-interfaces"),
        /expected \[ens19\.2000=10\.200\.0\.1\/24\], observed \[ens19\.2000\]/,
    );
});

test("a VLAN interface carrying an extra address is not spurious drift", () => {
    // Only the absence of the DESIRED address is drift; an operator's extra
    // address on the same interface must not make the check flap.
    const plan = buildGatewayPlan(baseInput({ groups: [group(2000)] }));
    const observation = matchingObservation(plan);
    const guest = observation.guest as { interfaces: Array<{ name: string; addresses: string[] }> };
    const vlan = guest.interfaces.find(({ name }) => name === "ens19.2000");
    vlan!.addresses = ["192.0.2.5/32", ...vlan!.addresses];

    assert.ok(!failures(plan, observation).includes("gateway-vlan-interfaces"));
});

test("a service that is running but not enabled at boot fails", () => {
    const plan = buildGatewayPlan(baseInput());
    const observation = matchingObservation(plan);
    const guest = observation.guest as { services: Record<string, unknown> };
    guest.services.squid = { active: true, enabled: false };

    assert.deepEqual(failures(plan, observation), ["gateway-services"]);
    assert.match(detailOf(plan, observation, "gateway-services"), /not enabled at boot: squid/);
});

test("dnsmasq bound off loopback fails, because that is a rogue DHCP server", () => {
    const plan = buildGatewayPlan(baseInput());
    const observation = matchingObservation(plan);
    const guest = observation.guest as { listeners: Array<Record<string, unknown>> };
    guest.listeners.push({ protocol: "udp", address: "172.16.0.36", port: 53 });

    assert.deepEqual(failures(plan, observation), ["gateway-dns-binding"]);
    assert.match(detailOf(plan, observation, "gateway-dns-binding"), /172\.16\.0\.36/);
});

test("dnsmasq bound to an allocated lab gateway address is expected, not drift", () => {
    const plan = buildGatewayPlan(baseInput({ groups: [group(2000)] }));
    const observation = matchingObservation(plan);
    const guest = observation.guest as { listeners: Array<Record<string, unknown>> };
    guest.listeners.push({ protocol: "udp", address: "10.200.0.1", port: 53 });

    assert.deepEqual(failures(plan, observation), []);
});

test("a second default route fails, since approved egress must be deterministic", () => {
    const plan = buildGatewayPlan(baseInput());
    const observation = matchingObservation(plan);
    (observation.guest as Record<string, unknown>).default_routes = [
        { gateway: "172.16.0.1", interface: "eth2" },
        { gateway: "10.10.10.1", interface: "eth0" },
    ];

    assert.deepEqual(failures(plan, observation), ["gateway-default-route"]);
});

test("a default route leaving by the management NIC fails", () => {
    const plan = buildGatewayPlan(baseInput());
    const observation = matchingObservation(plan);
    (observation.guest as Record<string, unknown>).default_routes = [
        { gateway: "10.10.10.1", interface: "eth0" },
    ];

    assert.deepEqual(failures(plan, observation), ["gateway-default-route"]);
});

test("a disconnected uplink fails", () => {
    const plan = buildGatewayPlan(baseInput());
    const observation = matchingObservation(plan);
    const devices = observation.network_devices as Record<string, Record<string, unknown>>;
    devices.net2.connected = false;

    assert.deepEqual(failures(plan, observation), ["gateway-uplink-connected"]);
});

test("an incomplete trunk allowlist fails", () => {
    const plan = buildGatewayPlan(baseInput());
    const observation = matchingObservation(plan);
    const devices = observation.network_devices as Record<string, Record<string, unknown>>;
    devices.net1.trunks = [2000, 2001];

    assert.deepEqual(failures(plan, observation), ["gateway-trunk-topology"]);
});

test("a missing management address fails", () => {
    const plan = buildGatewayPlan(baseInput());
    const observation = matchingObservation(plan);
    const guest = observation.guest as { interfaces: Array<Record<string, unknown>> };
    guest.interfaces = guest.interfaces.filter((entry) => entry.name !== "eth0");

    assert.deepEqual(failures(plan, observation), ["gateway-management-address"]);
});

test("forwarding disabled fails", () => {
    const plan = buildGatewayPlan(baseInput());
    const observation = matchingObservation(plan);
    (observation.guest as Record<string, unknown>).sysctl = {
        ipv4_forwarding: false,
        ipv6_disabled: true,
    };

    assert.deepEqual(failures(plan, observation), ["gateway-sysctl"]);
});

test("observer errors are reported even when everything else converges", () => {
    const plan = buildGatewayPlan(baseInput());
    const observation = matchingObservation(plan);
    observation.errors = ["guest observation timed out"];

    assert.deepEqual(failures(plan, observation), ["gateway-observer-errors"]);
});

test("a malformed observation is rejected rather than silently partially parsed", () => {
    const plan = buildGatewayPlan(baseInput());
    const observation = matchingObservation(plan);
    delete (observation.guest as Record<string, unknown>).nftables_revision;

    assert.throws(() => planGateway(plan, observation));
});

test("the client rejects a response whose request ID does not match", async () => {
    const client = new RestrictedSshGatewayObservationClient({
        execute: async () => {
            const plan = buildGatewayPlan(baseInput());
            return { ...matchingObservation(plan), request_id: "11111111-1111-4111-8111-111111111111" };
        },
    });

    await assert.rejects(
        () => client.observe(),
        /request ID does not match/,
    );
});

test("the client sends only the fixed observation request", async () => {
    let sent: unknown;
    const plan = buildGatewayPlan(baseInput());
    const client = new RestrictedSshGatewayObservationClient({
        execute: async (request) => {
            sent = request;
            const { request_id } = request as { request_id: string };
            return { ...matchingObservation(plan), request_id };
        },
    });

    await client.observe();
    const request = sent as Record<string, unknown>;
    assert.equal(request.version, 1);
    assert.equal(request.target, "gateway");
    assert.equal(request.operation, "observe");
    assert.deepEqual(Object.keys(request).sort(), ["operation", "request_id", "target", "version"]);
});
