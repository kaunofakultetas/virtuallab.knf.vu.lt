import { ProxmoxClient } from "@/proxmox/api";
import {
    ProxmoxApiError,
    ProxmoxGuestConfig,
    ProxmoxNodeNetwork,
    ProxmoxSdnVnet,
    ProxmoxSdnZone,
} from "@/proxmox/types";
import { networkProjectionConfig } from "./config";

export type ObservationStatus = "pass" | "fail" | "not_applicable";

export type NetworkObservation = {
    key: string;
    category: "proxmox" | "transport" | "sdn" | "gateway" | "access";
    status: ObservationStatus;
    required: boolean;
    detail: string;
    observed?: unknown;
};

export interface NetworkObservationClient {
    getNodeNetworks(): Promise<ProxmoxNodeNetwork[]>;
    getSdnZones(): Promise<ProxmoxSdnZone[]>;
    getSdnVnets(): Promise<ProxmoxSdnVnet[]>;
    getVmConfig(vmid: string): Promise<ProxmoxGuestConfig>;
    getContainerConfig(vmid: string): Promise<ProxmoxGuestConfig>;
}

function failureDetail(error: unknown): string {
    if (error instanceof ProxmoxApiError) {
        if (error.status === 401 || error.status === 403) {
            return `Proxmox API denied ${error.path} with status ${error.status}`;
        }
        if (error.status === 404) {
            return `Proxmox resource not found at ${error.path}`;
        }
        return `Proxmox API request to ${error.path} failed with status ${error.status}`;
    }
    if (error instanceof Error) return error.message;
    return String(error);
}

function guestObservation(
    key: "gateway" | "access",
    vmid: number,
    result: PromiseSettledResult<ProxmoxGuestConfig>,
): NetworkObservation {
    const label = key === "gateway" ? "Gateway VM" : "Access LXC";
    if (result.status === "rejected") {
        return {
            key: `${key}-config`,
            category: key,
            status: "fail",
            required: true,
            detail: `${label} ${vmid}: ${failureDetail(result.reason)}`,
        };
    }
    return {
        key: `${key}-config`,
        category: key,
        status: "pass",
        required: true,
        detail: `${label} ${vmid} configuration is readable`,
    };
}

function hasNetworkDevice(config: ProxmoxGuestConfig, expected: string): boolean {
    return Object.entries(config).some(
        ([key, value]) => /^net\d+$/.test(key) && String(value).includes(expected),
    );
}

/**
 * Finds an address on a QEMU guest.
 *
 * An LXC carries its address on `netN`, but a QEMU `netN` only describes the
 * virtual NIC; the address is supplied by cloud-init on `ipconfigN`. Searching
 * `netN` for an address therefore never matches on a VM.
 */
function hasCloudInitAddress(config: ProxmoxGuestConfig, cidr: string): boolean {
    return Object.entries(config).some(
        ([key, value]) => /^ipconfig\d+$/.test(key)
            && String(value).split(",").includes(`ip=${cidr}`),
    );
}

function findNetworkDevice(
    config: ProxmoxGuestConfig,
    expected: string,
): string | undefined {
    const entry = Object.entries(config).find(
        ([key, value]) => /^net\d+$/.test(key) && String(value).includes(expected),
    );
    return entry ? String(entry[1]) : undefined;
}

export async function getNetworkObservations(
    client?: NetworkObservationClient,
): Promise<NetworkObservation[]> {
    const observationClient = client ?? new ProxmoxClient({
        baseUrl: process.env.PROXMOX_BASE_URL!,
        nodeName: process.env.PROXMOX_NODE_NAME!,
        authToken: process.env.PROXMOX_AUTH_TOKEN!,
        rejectUnauthorized: process.env.PROXMOX_TLS_INSECURE !== "true",
    });
    const config = networkProjectionConfig;
    const [networks, zones, vnets, gateway, access] = await Promise.allSettled([
        observationClient.getNodeNetworks(),
        observationClient.getSdnZones(),
        observationClient.getSdnVnets(),
        observationClient.getVmConfig(String(config.proxmox.gatewayVmid)),
        observationClient.getContainerConfig(String(config.proxmox.accessVmid)),
    ]);
    const observations: NetworkObservation[] = [];

    if (networks.status === "rejected") {
        observations.push({
            key: "transport-bridge",
            category: "transport",
            status: "fail",
            required: true,
            detail: failureDetail(networks.reason),
        });
    } else {
        const bridge = networks.value.find(
            ({ iface }) => iface === config.proxmox.bridge,
        );
        const bridgeReady =
            bridge?.active === 1 && bridge.bridge_vlan_aware === 1;
        observations.push({
            key: "transport-bridge",
            category: "transport",
            status: bridgeReady ? "pass" : "fail",
            required: true,
            detail: bridge
                ? `${bridge.iface} is ${bridge.active === 1 ? "active" : "inactive"}; VLAN-aware=${bridge.bridge_vlan_aware === 1}`
                : `${config.proxmox.bridge} was not found`,
            observed: bridge,
        });
    }

    if (zones.status === "rejected") {
        observations.push({
            key: "sdn-zone",
            category: "sdn",
            status: "fail",
            required: true,
            detail: failureDetail(zones.reason),
        });
    } else {
        const zone = zones.value.find(({ zone }) => zone === config.proxmox.zone);
        observations.push({
            key: "sdn-zone",
            category: "sdn",
            status: zone ? "pass" : "fail",
            required: true,
            detail: zone
                ? `SDN zone ${zone.zone} is readable`
                : `SDN zone ${config.proxmox.zone} does not exist`,
            observed: zone,
        });
    }

    observations.push({
        key: "sdn-vnets",
        category: "sdn",
        status: vnets.status === "fulfilled" ? "pass" : "fail",
        required: true,
        detail:
            vnets.status === "fulfilled"
                ? `${vnets.value.length} SDN VNet(s) are readable`
                : failureDetail(vnets.reason),
        observed: vnets.status === "fulfilled" ? vnets.value : undefined,
    });
    observations.push(
        guestObservation("gateway", config.proxmox.gatewayVmid, gateway),
        guestObservation("access", config.proxmox.accessVmid, access),
    );
    if (gateway.status === "fulfilled") {
        const managementCidr = config.infrastructure.gatewayManagementCidr;
        // The Gateway is a QEMU VM, so its management address comes from
        // cloud-init rather than the NIC definition.
        const hasManagementNic = hasCloudInitAddress(gateway.value, managementCidr);
        const hasTransportNic = hasNetworkDevice(
            gateway.value,
            `bridge=${config.proxmox.bridge}`,
        );
        observations.push({
            key: "gateway-networking",
            category: "gateway",
            status: hasManagementNic && hasTransportNic ? "pass" : "fail",
            required: true,
            detail: `Gateway management NIC ${hasManagementNic ? "matches" : "does not match"} ${managementCidr}; transport NIC ${hasTransportNic ? "uses" : "does not use"} ${config.proxmox.bridge}`,
        });
    }
    if (access.status === "fulfilled") {
        const managementCidr = config.infrastructure.accessManagementCidr;
        const hasManagementNic = hasNetworkDevice(
            access.value,
            `ip=${managementCidr}`,
        );
        observations.push({
            key: "access-management",
            category: "access",
            status: hasManagementNic ? "pass" : "fail",
            required: true,
            detail: `Access LXC management NIC ${hasManagementNic ? "matches" : "does not match"} ${managementCidr}`,
        });
        const transportNic = findNetworkDevice(
            access.value,
            `bridge=${config.proxmox.bridge}`,
        );
        observations.push({
            key: "access-transport",
            category: "access",
            status: transportNic ? "pass" : "fail",
            required: true,
            detail: `Access LXC transport NIC ${transportNic ? "uses" : "does not use"} ${config.proxmox.bridge}`,
        });
        const hasUntaggedAddress = /(?:^|,)ip=[^,]+/.test(transportNic ?? "");
        observations.push({
            key: "access-transport-mode",
            category: "access",
            status: transportNic && !hasUntaggedAddress ? "pass" : "fail",
            required: true,
            detail: !transportNic
                ? `Access LXC has no transport NIC on ${config.proxmox.bridge}`
                : hasUntaggedAddress
                  ? `Access LXC transport still has an untagged address; migrate it to VLAN subinterfaces before active mode`
                  : "Access LXC transport has no untagged host address",
            observed: transportNic,
        });
        observations.push({
            key: "access-trunk-allowlist",
            category: "access",
            status: "not_applicable",
            required: false,
            detail: "No active network groups require VLAN trunk allowlist entries",
        });
    }
    return observations;
}