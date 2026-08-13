import { isIP } from "node:net";

/**
 * Picking a VM address is a trust boundary: the chosen address is handed to
 * Guacamole and to the web proxy, so a wrong pick points a user's session at a
 * machine that is not theirs. Every unverifiable input is refused here rather
 * than resolved by guesswork.
 */
export class AddressSelectionError extends Error {}

export type InstanceAddressSelection = {
    /**
     * The subnet of the instance's allocated network group, or `null` while the
     * group holds no allocation — which is every group in legacy and dry-run
     * mode.
     */
    subnetCidr: string | null;
    /**
     * Legacy fallback. The shared lab bridge is not modelled as a subnet, so the
     * configured address prefix stays the only signal available there.
     */
    legacyPrefix: string;
};

type Ipv4Network = {
    network: number;
    prefix: number;
};

function toIpv4Number(address: string): number {
    return address.split(".").reduce(
        (result, octet) => (result << 8) | Number(octet),
        0,
    ) >>> 0;
}

function maskFor(prefix: number): number {
    return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

function parseIpv4Cidr(cidr: string): Ipv4Network {
    const [address, prefixText, extra] = cidr.split("/");
    // Number("") is 0, so a trailing slash would otherwise parse as /0 and match
    // every address on earth.
    if (extra !== undefined || isIP(address) !== 4 || !/^\d{1,2}$/.test(prefixText ?? "")) {
        throw new AddressSelectionError(`Invalid IPv4 CIDR: ${cidr}`);
    }
    const prefix = Number(prefixText);
    // A /0 matches every address, which is the same hazard the trailing-slash
    // guard above exists to prevent -- just spelled explicitly. Lab subnets are
    // /24 by contract, so anything wider than /8 is a configuration error rather
    // than a narrow network, and guessing from it would defeat the point of
    // selecting by membership at all.
    if (prefix > 32 || prefix < 8) {
        throw new AddressSelectionError(`Invalid IPv4 CIDR prefix: ${cidr}`);
    }
    return { network: toIpv4Number(address) & maskFor(prefix), prefix };
}

function contains(network: Ipv4Network, address: string): boolean {
    return (toIpv4Number(address) & maskFor(network.prefix)) === network.network;
}

// The guest agent reports these while DHCP is still running, or for the guest's
// own loopback. None of them can ever identify a reachable VM.
const UNROUTABLE_RANGES = ["0.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16"].map(parseIpv4Cidr);

function usableIpv4Addresses(addresses: readonly string[]): string[] {
    return addresses.filter(
        (address) =>
            isIP(address) === 4 &&
            !UNROUTABLE_RANGES.some((range) => contains(range, address)),
    );
}

/**
 * Resolves the address a session should target from the IPv4 addresses reported
 * by the QEMU guest agent.
 *
 * With an allocated subnet, only membership in that subnet qualifies: a string
 * prefix cannot express a mask, so `10.10.100.5` would pass a `10.10.` test
 * while sitting outside `10.10.10.0/24`. Nothing falls back to the prefix in
 * that case — an isolated VM that has not yet taken a lease on its own subnet
 * must report "not ready", never an address on some other network.
 */
export function selectInstanceAddress(
    addresses: readonly string[],
    selection: InstanceAddressSelection,
): string | null {
    const candidates = usableIpv4Addresses(addresses);
    const { subnetCidr, legacyPrefix } = selection;

    if (subnetCidr != null) {
        const subnet = parseIpv4Cidr(subnetCidr);
        // Lowest address wins, so a guest holding several leases on its subnet
        // resolves to the same address on every poll regardless of the order the
        // agent enumerated its interfaces in.
        const members = candidates
            .filter((address) => contains(subnet, address))
            .sort((left, right) => toIpv4Number(left) - toIpv4Number(right));
        if (members.length > 0) return members[0];
        // A group is reused for every VM its owner launches on that profile, so a
        // VM provisioned on the legacy bridge keeps pointing at a group that may
        // be allocated a subnet later. Without this fallback that VM resolves to
        // null on every poll forever -- a permanently unreachable machine on the
        // only provisioning path that currently works. Falling back cannot select
        // someone else's machine: every candidate here was reported by this VM's
        // own guest agent.
    }

    if (legacyPrefix === "") {
        throw new AddressSelectionError(
            "Legacy address selection requires a non-empty address prefix",
        );
    }
    // First match, matching the historical selection order: on the shared bridge
    // every candidate belongs to the same flat network, so reordering here would
    // only churn existing Guacamole connections.
    return candidates.find((address) => address.startsWith(legacyPrefix)) ?? null;
}
