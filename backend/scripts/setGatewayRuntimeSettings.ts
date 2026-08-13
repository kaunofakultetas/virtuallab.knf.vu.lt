import { isIP } from "node:net";
import { GATEWAY_SETTING_KEYS } from "@/network/gateway-plan";
import { metadata } from "@/utils/metadata";
import { pool } from "@/utils/db";

/**
 * Records the Gateway guest's real interface names and upstream resolvers.
 *
 * These cannot be derived from the database, and the names are not predictable:
 * cloud-init renames only the NICs it has configuration for, so a guest can end
 * up with a mix such as eth0/ens19/eth2. Read them from the running VM and pass
 * them in rather than assuming a pattern.
 */
const INTERFACE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,14}$/;

function requiredInterface(variable: string): string {
    const value = process.env[variable]?.trim();
    if (!value || !INTERFACE_NAME_PATTERN.test(value)) {
        throw new Error(`${variable} must be a valid interface name observed on the Gateway`);
    }
    return value;
}

function requiredResolvers(variable: string): string[] {
    const raw = process.env[variable]?.trim();
    if (!raw) throw new Error(`${variable} must list at least one resolver`);
    const resolvers = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
    if (resolvers.length === 0) throw new Error(`${variable} must list at least one resolver`);
    for (const resolver of resolvers) {
        if (isIP(resolver) !== 4) {
            throw new Error(`${variable} entry ${resolver} must be a literal IPv4 address`);
        }
    }
    return [...new Set(resolvers)];
}

async function main(): Promise<void> {
    const management = requiredInterface("GATEWAY_MANAGEMENT_INTERFACE");
    const trunk = requiredInterface("GATEWAY_TRUNK_INTERFACE");
    const uplink = requiredInterface("GATEWAY_UPLINK_INTERFACE");
    const resolvers = requiredResolvers("GATEWAY_UPSTREAM_RESOLVERS");

    if (new Set([management, trunk, uplink]).size !== 3) {
        throw new Error("Gateway management, trunk, and uplink interfaces must be distinct");
    }

    try {
        await metadata.set(GATEWAY_SETTING_KEYS.managementInterface, management);
        await metadata.set(GATEWAY_SETTING_KEYS.trunkInterface, trunk);
        await metadata.set(GATEWAY_SETTING_KEYS.uplinkInterface, uplink);
        await metadata.set(GATEWAY_SETTING_KEYS.upstreamResolvers, resolvers);
        process.stdout.write(`${JSON.stringify({
            management_interface: management,
            trunk_interface: trunk,
            uplink_interface: uplink,
            upstream_resolvers: resolvers,
        })}\n`);
    } finally {
        await pool.end();
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Failed to record Gateway settings");
    process.exitCode = 1;
});
