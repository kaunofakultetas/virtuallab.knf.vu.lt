import { z } from "zod";
import { AccessApplyClient, RestrictedSshAccessApplyClient } from "./access-apply";
import {
    AccessTrunkApplyClient,
    RestrictedSshAccessTrunkApplyClient,
} from "./access-trunk-apply";
import {
    AccessObservationClient,
    RestrictedSshAccessObservationClient,
} from "./adapters/access";
import { RestrictedSshTransport } from "./adapters/restricted-ssh";

/**
 * Construction of the three Access SSH channels, kept in one place so the
 * read-only and mutating principals cannot drift apart. The Gateway equivalent
 * lives in `gateway-clients.ts` and follows the same rules.
 *
 * They are separate keys with separate forced commands on purpose: the observer
 * cannot change anything, neither applier can be used to read arbitrary state,
 * and the two appliers are separated from each other because they mutate
 * different things — the guest's files versus the hypervisor's NIC. An apply
 * proves convergence through the observer channel precisely because it is a
 * different key on a different connection.
 *
 * Identity and known-hosts paths must be absolute: a relative path would resolve
 * against whatever the process working directory happens to be.
 */

const observerConfigSchema = z.object({
    ACCESS_OBSERVER_HOST: z.string().min(1),
    ACCESS_OBSERVER_PORT: z.coerce.number().int().min(1).max(65535).default(22),
    ACCESS_OBSERVER_HOST_KEY_ALIAS: z.string().min(1).optional(),
    ACCESS_OBSERVER_USER: z.string().min(1),
    ACCESS_OBSERVER_IDENTITY_FILE: z.string().startsWith("/"),
    ACCESS_OBSERVER_KNOWN_HOSTS_FILE: z.string().startsWith("/"),
    ACCESS_OBSERVER_COMMAND: z.string().min(1).default("virtual-lab-access-observe"),
});

const applierConfigSchema = z.object({
    ACCESS_APPLIER_HOST: z.string().min(1),
    ACCESS_APPLIER_PORT: z.coerce.number().int().min(1).max(65535).default(22),
    ACCESS_APPLIER_HOST_KEY_ALIAS: z.string().min(1).optional(),
    ACCESS_APPLIER_USER: z.string().min(1),
    ACCESS_APPLIER_IDENTITY_FILE: z.string().startsWith("/"),
    ACCESS_APPLIER_KNOWN_HOSTS_FILE: z.string().startsWith("/"),
    ACCESS_APPLIER_COMMAND: z.string().min(1).default("virtual-lab-access-apply"),
});

const trunkApplierConfigSchema = z.object({
    ACCESS_TRUNK_APPLIER_HOST: z.string().min(1),
    ACCESS_TRUNK_APPLIER_PORT: z.coerce.number().int().min(1).max(65535).default(22),
    ACCESS_TRUNK_APPLIER_HOST_KEY_ALIAS: z.string().min(1).optional(),
    ACCESS_TRUNK_APPLIER_USER: z.string().min(1),
    ACCESS_TRUNK_APPLIER_IDENTITY_FILE: z.string().startsWith("/"),
    ACCESS_TRUNK_APPLIER_KNOWN_HOSTS_FILE: z.string().startsWith("/"),
    ACCESS_TRUNK_APPLIER_COMMAND: z.string().min(1).default("virtual-lab-access-trunk-apply"),
});

export class AccessClientConfigurationError extends Error {
    constructor(readonly channel: string, readonly missing: string[]) {
        super(`Access ${channel} is not configured: ${missing.join(", ")}`);
        this.name = "AccessClientConfigurationError";
    }
}

function missingKeys(error: z.ZodError): string[] {
    return [...new Set(error.issues.map((issue) => issue.path.join(".")))].sort();
}

/**
 * Throws when unconfigured rather than returning null. Unlike the Gateway
 * observer, whose absence merely drops some dry-run checks, Access observation
 * is what every Access apply proves itself against — a stack that cannot observe
 * must not be allowed to look like one that observed nothing wrong.
 */
export function createAccessObserver(
    environment: NodeJS.ProcessEnv = process.env,
): AccessObservationClient {
    const config = observerConfigSchema.safeParse(environment);
    if (!config.success) {
        throw new AccessClientConfigurationError("observer", missingKeys(config.error));
    }
    return new RestrictedSshAccessObservationClient(new RestrictedSshTransport({
        host: config.data.ACCESS_OBSERVER_HOST,
        port: config.data.ACCESS_OBSERVER_PORT,
        hostKeyAlias: config.data.ACCESS_OBSERVER_HOST_KEY_ALIAS,
        user: config.data.ACCESS_OBSERVER_USER,
        identityFile: config.data.ACCESS_OBSERVER_IDENTITY_FILE,
        knownHostsFile: config.data.ACCESS_OBSERVER_KNOWN_HOSTS_FILE,
        remoteCommand: config.data.ACCESS_OBSERVER_COMMAND,
        // The guest observation runs inside `pct exec` within the forced
        // command, so it needs more headroom than a plain host command.
        executionTimeoutMs: 45_000,
    }));
}

/**
 * The guest policy applier. Throws when unconfigured, because every caller is an
 * explicit mutation request and silently doing nothing would be worse than
 * refusing.
 */
export function createAccessApplier(
    environment: NodeJS.ProcessEnv = process.env,
): AccessApplyClient {
    const config = applierConfigSchema.safeParse(environment);
    if (!config.success) {
        throw new AccessClientConfigurationError("applier", missingKeys(config.error));
    }
    return new RestrictedSshAccessApplyClient(new RestrictedSshTransport({
        host: config.data.ACCESS_APPLIER_HOST,
        port: config.data.ACCESS_APPLIER_PORT,
        hostKeyAlias: config.data.ACCESS_APPLIER_HOST_KEY_ALIAS,
        user: config.data.ACCESS_APPLIER_USER,
        identityFile: config.data.ACCESS_APPLIER_IDENTITY_FILE,
        knownHostsFile: config.data.ACCESS_APPLIER_KNOWN_HOSTS_FILE,
        remoteCommand: config.data.ACCESS_APPLIER_COMMAND,
        // Staging reloads networkd and nftables inside the container through
        // `pct exec`. The guest's own rollback timer bounds the damage if this
        // is cut short, so a generous ceiling is safer than a premature abort.
        executionTimeoutMs: 180_000,
        // A stage request carries the whole rendered configuration.
        maxOutputBytes: 512 * 1024,
    }));
}

/**
 * The hypervisor-side trunk applier. Separate from the policy applier because it
 * runs entirely on the Proxmox host — `pct set` and `bridge vlan` — and never
 * enters the container.
 */
export function createAccessTrunkApplier(
    environment: NodeJS.ProcessEnv = process.env,
): AccessTrunkApplyClient {
    const config = trunkApplierConfigSchema.safeParse(environment);
    if (!config.success) {
        throw new AccessClientConfigurationError("trunk applier", missingKeys(config.error));
    }
    return new RestrictedSshAccessTrunkApplyClient(new RestrictedSshTransport({
        host: config.data.ACCESS_TRUNK_APPLIER_HOST,
        port: config.data.ACCESS_TRUNK_APPLIER_PORT,
        hostKeyAlias: config.data.ACCESS_TRUNK_APPLIER_HOST_KEY_ALIAS,
        user: config.data.ACCESS_TRUNK_APPLIER_USER,
        identityFile: config.data.ACCESS_TRUNK_APPLIER_IDENTITY_FILE,
        knownHostsFile: config.data.ACCESS_TRUNK_APPLIER_KNOWN_HOSTS_FILE,
        remoteCommand: config.data.ACCESS_TRUNK_APPLIER_COMMAND,
        // No second hop and no file transfer, but `pct set` can take a while
        // when it reconfigures a running NIC.
        executionTimeoutMs: 60_000,
    }));
}
