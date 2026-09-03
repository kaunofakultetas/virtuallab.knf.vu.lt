// -----------------------------------------------------------
//  [*] Network — the approved projection: VLANs, subnets,
//      addresses
//
//  The single source of the lab network's shape: 256 VLANs
//  (2000-2255) mapping one-to-one onto the /24s of
//  10.200.0.0/16, with fixed host numbers for the Gateway
//  (.1) and Access (.2) and the DHCP range after them.
//  getNetworkSlot() is the only translation from a VLAN tag
//  to its canonical VNet/subnet/addresses — every renderer
//  and policy builder derives from it, never from observed
//  state.
//
//  Split into (validator last):
//
//    networkProjectionConfig        — the approved values
//    getNetworkSlot                 — VLAN tag → slot
//    validateNetworkProjectionConfig — invariant checks
//
//  Used by:
//    - desired-state.ts, gateway-desired-state.ts,
//      access-desired-state.ts — plan building
//    - provisioning-firewall.ts, groups.ts, attachment.ts,
//      readiness.ts and the renderers
// -----------------------------------------------------------

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
        gatewayManagementSourceCidrs: string[];
        accessManagementCidr: string;
        accessServiceSourceCidrs: string[];
    };
    ipv6: {
        enabled: false;
    };
};








// -----------------------------------------------------------
// networkProjectionConfig
// -----------------------------------------------------------
//
// The approved values. Changing any of these changes every
// derived plan revision at once.
//
// Used by:
//   - getNetworkSlot (below) and every plan builder
// -----------------------------------------------------------

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
        // The orchestrator LXC, plus the Proxmox host itself. The host is the
        // out-of-band administration path for the Gateway guest and the only way
        // in if a ruleset is wrong: VM 202 has no serial console, so losing SSH
        // would mean offline disk surgery. The host already controls the VM
        // through the hypervisor, so this grants no privilege it lacks.
        gatewayManagementSourceCidrs: ["10.10.10.1/32", "10.10.10.100/32"],
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








// -----------------------------------------------------------
// getNetworkSlot
// -----------------------------------------------------------
//
// VLAN tag → its canonical slot: lab<tag> as the VNet name,
// 10.200.<tag-2000>.0/24 as the subnet, and the fixed host
// addresses within it. Refuses tags outside the approved
// pool.
//
// Used by:
//   - desired-state.ts, provisioning-firewall.ts, groups.ts
// -----------------------------------------------------------

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








// -----------------------------------------------------------
// validateNetworkProjectionConfig
// -----------------------------------------------------------
//
// The invariants the slot arithmetic assumes: exactly 256
// VLANs onto exactly the /24s of 10.200.0.0/16, host
// numbers in range and non-overlapping with the DHCP
// window, IPv6 off until isolation policy exists for it.
//
// Used by:
//   - getNetworkSlot (above) — on every call
//   - readiness.ts — the configuration check
// -----------------------------------------------------------

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
