import assert from "node:assert/strict";
import test from "node:test";
import {
    getNetworkObservations,
    NetworkObservationClient,
} from "../src/network/observations";
import { ProxmoxApiError } from "../src/proxmox/types";

function createClient(
    overrides: Partial<NetworkObservationClient> = {},
): NetworkObservationClient {
    return {
        getNodeNetworks: async () => [
            {
                iface: "vmbr20",
                type: "bridge",
                active: 1,
                bridge_vlan_aware: 1,
            },
        ],
        getSdnZones: async () => [
            { zone: "labzone", type: "simple", bridge: "vmbr20" },
        ],
        getSdnVnets: async () => [],
        getVmConfig: async () => ({
            net0: "bridge=vmbr1,ip=10.10.10.2/24",
            net1: "bridge=vmbr20",
        }),
        getContainerConfig: async () => ({
            net0: "bridge=vmbr1,ip=10.10.10.50/24",
            net1: "bridge=vmbr20,ip=10.10.20.10/24",
        }),
        ...overrides,
    };
}

test("reports each infrastructure observation independently", async () => {
    const observations = await getNetworkObservations(
        createClient({
            getSdnZones: async () => {
                throw new ProxmoxApiError(
                    "denied",
                    403,
                    "/cluster/sdn/zones",
                );
            },
        }),
    );

    assert.equal(
        observations.find(({ key }) => key === "sdn-zone")?.status,
        "fail",
    );
    assert.match(
        observations.find(({ key }) => key === "sdn-zone")?.detail ?? "",
        /denied.*403/,
    );
    assert.equal(
        observations.find(({ key }) => key === "transport-bridge")?.status,
        "pass",
    );
    assert.equal(
        observations.find(({ key }) => key === "access-transport")?.status,
        "pass",
    );
    assert.equal(
        observations.find(({ key }) => key === "access-management")?.status,
        "pass",
    );
    assert.equal(
        observations.find(({ key }) => key === "access-transport-mode")?.status,
        "fail",
    );
});

test("distinguishes missing bridge, zone, and Gateway from readable inventory", async () => {
    const observations = await getNetworkObservations(
        createClient({
            getNodeNetworks: async () => [],
            getSdnZones: async () => [],
            getVmConfig: async () => {
                throw new ProxmoxApiError(
                    "missing",
                    500,
                    "/nodes/node/qemu/202/config",
                );
            },
        }),
    );

    assert.equal(
        observations.find(({ key }) => key === "transport-bridge")?.status,
        "fail",
    );
    assert.equal(
        observations.find(({ key }) => key === "sdn-zone")?.status,
        "fail",
    );
    assert.equal(
        observations.find(({ key }) => key === "sdn-vnets")?.status,
        "pass",
    );
    assert.equal(
        observations.find(({ key }) => key === "gateway-config")?.status,
        "fail",
    );
});

test("requires the active transport bridge to be VLAN-aware", async () => {
    const observations = await getNetworkObservations(
        createClient({
            getNodeNetworks: async () => [
                {
                    iface: "vmbr20",
                    type: "bridge",
                    active: 1,
                    bridge_vlan_aware: 0,
                },
            ],
        }),
    );

    const bridge = observations.find(({ key }) => key === "transport-bridge");
    assert.equal(bridge?.status, "fail");
    assert.match(bridge?.detail ?? "", /VLAN-aware=false/);
});

test("validates guest topology without requiring an inactive VLAN allowlist", async () => {
    const observations = await getNetworkObservations(
        createClient({
            getContainerConfig: async () => ({
                net0: "bridge=vmbr1,ip=10.10.10.50/24",
                net1: "bridge=vmbr20",
            }),
        }),
    );

    assert.equal(
        observations.find(({ key }) => key === "gateway-networking")?.status,
        "pass",
    );
    assert.equal(
        observations.find(({ key }) => key === "access-transport")?.status,
        "pass",
    );
    assert.equal(
        observations.find(({ key }) => key === "access-transport-mode")?.status,
        "pass",
    );
    assert.deepEqual(
        observations.find(({ key }) => key === "access-trunk-allowlist"),
        {
            key: "access-trunk-allowlist",
            category: "access",
            status: "not_applicable",
            required: false,
            detail: "No active network groups require VLAN trunk allowlist entries",
        },
    );
});

test("blocks active mode while Access uses an untagged transport address", async () => {
    const observations = await getNetworkObservations(createClient());
    const transportMode = observations.find(
        ({ key }) => key === "access-transport-mode",
    );

    assert.equal(transportMode?.status, "fail");
    assert.equal(transportMode?.required, true);
    assert.match(transportMode?.detail ?? "", /untagged address/);
    assert.match(String(transportMode?.observed), /ip=10\.10\.20\.10\/24/);
});

test("requires the approved Access management address", async () => {
    const observations = await getNetworkObservations(
        createClient({
            getContainerConfig: async () => ({
                net0: "bridge=vmbr1,ip=10.10.10.51/24",
                net1: "bridge=vmbr20",
            }),
        }),
    );

    const management = observations.find(
        ({ key }) => key === "access-management",
    );
    assert.equal(management?.status, "fail");
    assert.equal(management?.required, true);
    assert.match(management?.detail ?? "", /does not match 10\.10\.10\.50\/24/);
});