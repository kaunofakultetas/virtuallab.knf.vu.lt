import { isIP } from "node:net";
import z from "zod";
import { AccessPlan } from "./access-desired-state";

const ipv4CidrSchema = z.string().refine((cidr) => {
    const [address, prefixText, extra] = cidr.split("/");
    const prefix = Number(prefixText);
    return extra === undefined && isIP(address) === 4 && Number.isInteger(prefix) && prefix >= 0 && prefix <= 32;
}, "Invalid IPv4 CIDR");

const ipv4Schema = z.string().refine((address) => isIP(address) === 4, "Invalid IPv4 address");

export const accessObservationSchema = z.object({
    version: z.literal(1),
    captured_at: z.iso.datetime(),
    hostname: z.string().min(1),
    interfaces: z.array(z.object({
        name: z.string().min(1),
        addresses: z.array(ipv4CidrSchema),
    })),
    docker_bridge_cidrs: z.array(ipv4CidrSchema),
    listeners: z.array(z.object({
        port: z.number().int().min(1).max(65535),
        local_address: ipv4Schema,
    })),
    connections: z.array(z.object({
        local_port: z.number().int().min(1).max(65535),
        remote_address: ipv4Schema,
    })),
    sysctl: z.object({
        ipv4_forwarding: z.boolean(),
        ipv6_enabled: z.boolean(),
    }),
    nftables: z.object({
        available: z.boolean(),
        ruleset: z.string(),
    }),
    errors: z.array(z.string()),
});

export type AccessObservation = z.infer<typeof accessObservationSchema>;
export type AccessDriftStatus = "pass" | "fail" | "unobserved";

export type AccessDriftCheck = {
    key: string;
    status: AccessDriftStatus;
    detail: string;
};

export type AccessDriftReport = {
    desired_revision: string;
    ready: boolean;
    checks: AccessDriftCheck[];
    observation_errors: string[];
};

function sorted(values: string[]): string[] {
    return [...new Set(values)].sort();
}

function sameValues(left: string[], right: string[]): boolean {
    return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function interfaceAddresses(observation: AccessObservation, name: string): string[] {
    return observation.interfaces.find((networkInterface) => networkInterface.name === name)?.addresses ?? [];
}

function cidrContainsAddress(cidr: string, address: string): boolean {
    const [network, prefixText] = cidr.split("/");
    const prefix = Number(prefixText);
    const toNumber = (value: string) => value.split(".").reduce(
        (result, octet) => (result << 8) | Number(octet),
        0,
    ) >>> 0;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (toNumber(network) & mask) === (toNumber(address) & mask);
}

export function compareAccessObservation(
    plan: AccessPlan,
    input: unknown,
): AccessDriftReport {
    const observation = accessObservationSchema.parse(input);
    const desired = plan.desired_state;
    const checks: AccessDriftCheck[] = [];
    const managementAddresses = interfaceAddresses(observation, "eth0");
    checks.push({
        key: "management-address",
        status: managementAddresses.includes(desired.management.address_cidr) ? "pass" : "fail",
        detail: `eth0 addresses: ${managementAddresses.join(", ") || "none"}`,
    });

    const parentAddresses = interfaceAddresses(observation, desired.transport.parent_interface);
    checks.push({
        key: "legacy-transport-address",
        status: parentAddresses.length === 0 ? "pass" : "fail",
        detail: `${desired.transport.parent_interface} addresses: ${parentAddresses.join(", ") || "none"}`,
    });

    const desiredVlanAddresses = desired.transport.interfaces.map(
        ({ interface_name, address_cidr }) => `${interface_name}=${address_cidr}`,
    );
    const observedVlanAddresses = observation.interfaces
        .filter(({ name }) => name.startsWith(`${desired.transport.parent_interface}.`))
        .flatMap(({ name, addresses }) => addresses.map((address) => `${name}=${address}`));
    checks.push({
        key: "vlan-interfaces",
        status: sameValues(desiredVlanAddresses, observedVlanAddresses) ? "pass" : "fail",
        detail: `expected [${sorted(desiredVlanAddresses).join(", ")}], observed [${sorted(observedVlanAddresses).join(", ")}]`,
    });

    checks.push({
        key: "docker-bridges",
        status: sameValues(desired.docker.bridge_cidrs, observation.docker_bridge_cidrs) ? "pass" : "fail",
        detail: `Docker bridge CIDRs: ${sorted(observation.docker_bridge_cidrs).join(", ") || "none"}`,
    });

    for (const port of desired.management.service_ports) {
        const bindings = observation.listeners
            .filter((listener) => listener.port === port)
            .map(({ local_address }) => local_address);
        checks.push({
            key: `service-${port}-binding`,
            status: bindings.length > 0 && bindings.every(
                (address) => address === desired.management.address_cidr.split("/")[0],
            ) ? "pass" : "fail",
            detail: `TCP ${port} bindings: ${bindings.join(", ") || "none"}`,
        });

        const sources = observation.connections
            .filter((connection) => connection.local_port === port)
            .map(({ remote_address }) => remote_address);
        checks.push({
            key: `service-${port}-source`,
            status: sources.length === 0
                ? "unobserved"
                : sources.every((source) => desired.management.allowed_sources.some(
                    (cidr) => cidrContainsAddress(cidr, source),
                )) ? "pass" : "fail",
            detail: sources.length === 0
                ? `No active TCP ${port} connections were captured`
                : `TCP ${port} source addresses: ${sorted(sources).join(", ")}`,
        });
    }

    checks.push({
        key: "ipv4-forwarding",
        status: observation.sysctl.ipv4_forwarding ? "pass" : "fail",
        detail: `net.ipv4.ip_forward=${observation.sysctl.ipv4_forwarding ? 1 : 0}`,
    });
    checks.push({
        key: "ipv6-disabled",
        status: !observation.sysctl.ipv6_enabled ? "pass" : "fail",
        detail: `IPv6 is ${observation.sysctl.ipv6_enabled ? "enabled" : "disabled"}`,
    });
    checks.push({
        key: "nftables-revision",
        status: observation.nftables.available && observation.nftables.ruleset.includes(
            `Access desired-state revision ${plan.revision}`,
        )
            ? "pass"
            : "fail",
        detail: !observation.nftables.available
            ? "nftables ruleset is unavailable"
            : `nftables ruleset ${observation.nftables.ruleset.includes(plan.revision) ? "matches" : "does not match"} revision ${plan.revision}`,
    });

    return {
        desired_revision: plan.revision,
        ready: observation.errors.length === 0 && checks.every(({ status }) => status === "pass"),
        checks,
        observation_errors: observation.errors,
    };
}