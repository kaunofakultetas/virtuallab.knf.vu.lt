export type NetworkProjectionConfig = {
    version: 1;
    vlan: {
        first: number;
        last: number;
    };
    ipv4: {
        supernet: string;
        groupPrefix: 24;
        gatewayHost: number;
        accessHost: number;
        dhcpFirstHost: number;
        dhcpLastHost: number;
    };
    proxmox: {
        zone: string;
        bridge: string;
        gatewayVmid: number;
        accessVmid: number;
    };
    infrastructure: {
        gatewayManagementCidr: string;
        accessManagementCidr: string;
        accessServiceSourceCidrs: string[];
    };
    ipv6: {
        enabled: false;
    };
};

export const networkProjectionConfig: NetworkProjectionConfig = {
    version: 1,
    vlan: {
        first: 2000,
        last: 2255,
    },
    ipv4: {
        supernet: "10.200.0.0/16",
        groupPrefix: 24,
        gatewayHost: 1,
        accessHost: 2,
        dhcpFirstHost: 25,
        dhcpLastHost: 254,
    },
    proxmox: {
        zone: "labzone",
        bridge: "vmbr20",
        gatewayVmid: 202,
        accessVmid: 200,
    },
    infrastructure: {
        gatewayManagementCidr: "10.10.10.2/24",
        accessManagementCidr: "10.10.10.50/24",
        accessServiceSourceCidrs: ["10.10.10.100/32"],
    },
    ipv6: {
        enabled: false,
    },
};

export type NetworkSlot = {
    vlanTag: number;
    vnetName: string;
    subnetCidr: string;
    gatewayIp: string;
    accessIp: string;
    dhcpFirstIp: string;
    dhcpLastIp: string;
};

export function getNetworkSlot(
    vlanTag: number,
    config: NetworkProjectionConfig = networkProjectionConfig,
): NetworkSlot {
    validateNetworkProjectionConfig(config);
    if (!Number.isInteger(vlanTag) || vlanTag < config.vlan.first || vlanTag > config.vlan.last) {
        throw new Error(
            `VLAN ${vlanTag} is outside the approved pool ${config.vlan.first}-${config.vlan.last}`,
        );
    }

    const subnetIndex = vlanTag - config.vlan.first;
    const subnetPrefix = `10.200.${subnetIndex}`;
    return {
        vlanTag,
        vnetName: `lab${vlanTag}`,
        subnetCidr: `${subnetPrefix}.0/24`,
        gatewayIp: `${subnetPrefix}.${config.ipv4.gatewayHost}`,
        accessIp: `${subnetPrefix}.${config.ipv4.accessHost}`,
        dhcpFirstIp: `${subnetPrefix}.${config.ipv4.dhcpFirstHost}`,
        dhcpLastIp: `${subnetPrefix}.${config.ipv4.dhcpLastHost}`,
    };
}

export function validateNetworkProjectionConfig(
    config: NetworkProjectionConfig = networkProjectionConfig,
): void {
    const vlanCount = config.vlan.last - config.vlan.first + 1;
    if (vlanCount !== 256) {
        throw new Error(`Expected 256 VLANs, received ${vlanCount}`);
    }
    if (config.ipv4.supernet !== "10.200.0.0/16" || config.ipv4.groupPrefix !== 24) {
        throw new Error("The approved IPv4 projection pool is 10.200.0.0/16 split into /24 networks");
    }

    const hosts = [
        config.ipv4.gatewayHost,
        config.ipv4.accessHost,
        config.ipv4.dhcpFirstHost,
        config.ipv4.dhcpLastHost,
    ];
    if (hosts.some((host) => !Number.isInteger(host) || host < 1 || host > 254)) {
        throw new Error("Infrastructure and DHCP host addresses must be between 1 and 254");
    }
    if (
        config.ipv4.gatewayHost === config.ipv4.accessHost ||
        config.ipv4.dhcpFirstHost <= Math.max(config.ipv4.gatewayHost, config.ipv4.accessHost) ||
        config.ipv4.dhcpFirstHost > config.ipv4.dhcpLastHost
    ) {
        throw new Error("Infrastructure addresses and DHCP range overlap or are out of order");
    }
    if (config.ipv6.enabled) {
        throw new Error("IPv6 must remain disabled until equivalent isolation policy is implemented");
    }
}