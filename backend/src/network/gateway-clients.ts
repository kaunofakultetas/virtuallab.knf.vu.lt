// -----------------------------------------------------------
//  [*] Network — the two Gateway SSH channels
//
//  Construction of the Gateway observer and applier, kept in
//  one place so the read-only and mutating principals cannot
//  drift apart.
//
//  They are separate keys with separate forced commands on
//  purpose: the observer cannot change anything, and the
//  applier cannot be used to read state. An apply proves
//  convergence through the observer channel precisely
//  because it is a different key on a different connection.
//
//  Used by:
//    - network.route.ts, readiness.ts, drift-reconciler.ts —
//      the observer
//    - provisioning-network.ts, teardown.ts,
//      drift-reconciler.ts, scripts/applyGatewayPolicy.ts —
//      the applier
// -----------------------------------------------------------

import { z } from "zod";
import {
    GatewayObservationClient,
    RestrictedSshGatewayObservationClient,
} from "./adapters/gateway";
import { RestrictedSshTransport } from "./adapters/restricted-ssh";
import { GatewayApplyClient, RestrictedSshGatewayApplyClient } from "./gateway-apply";

const observerConfigSchema = z.object({
    GATEWAY_OBSERVER_HOST: z.string().min(1),
    GATEWAY_OBSERVER_PORT: z.coerce.number().int().min(1).max(65535).default(22),
    GATEWAY_OBSERVER_HOST_KEY_ALIAS: z.string().min(1).optional(),
    GATEWAY_OBSERVER_USER: z.string().min(1),
    GATEWAY_OBSERVER_IDENTITY_FILE: z.string().startsWith("/"),
    GATEWAY_OBSERVER_KNOWN_HOSTS_FILE: z.string().startsWith("/"),
    GATEWAY_OBSERVER_COMMAND: z.string().min(1).default("virtual-lab-gateway-observe"),
});

const applierConfigSchema = z.object({
    GATEWAY_APPLIER_HOST: z.string().min(1),
    GATEWAY_APPLIER_PORT: z.coerce.number().int().min(1).max(65535).default(22),
    GATEWAY_APPLIER_HOST_KEY_ALIAS: z.string().min(1).optional(),
    GATEWAY_APPLIER_USER: z.string().min(1),
    GATEWAY_APPLIER_IDENTITY_FILE: z.string().startsWith("/"),
    GATEWAY_APPLIER_KNOWN_HOSTS_FILE: z.string().startsWith("/"),
    GATEWAY_APPLIER_COMMAND: z.string().min(1).default("virtual-lab-gateway-apply"),
});

export class GatewayClientConfigurationError extends Error {}








// -----------------------------------------------------------
// createGatewayObserver
// -----------------------------------------------------------
//
// The observer is optional: a stack without a provisioned
// principal still produces a useful dry-run, it just
// reports no Gateway checks. Returns null rather than
// throwing so the caller can degrade instead of failing.
//
// Used by:
//   - network.route.ts, readiness.ts, drift-reconciler.ts
// -----------------------------------------------------------

export function createGatewayObserver(
    environment: NodeJS.ProcessEnv = process.env,
): GatewayObservationClient | null {
    const config = observerConfigSchema.safeParse(environment);
    if (!config.success) return null;
    return new RestrictedSshGatewayObservationClient(new RestrictedSshTransport({
        host: config.data.GATEWAY_OBSERVER_HOST,
        port: config.data.GATEWAY_OBSERVER_PORT,
        hostKeyAlias: config.data.GATEWAY_OBSERVER_HOST_KEY_ALIAS,
        user: config.data.GATEWAY_OBSERVER_USER,
        identityFile: config.data.GATEWAY_OBSERVER_IDENTITY_FILE,
        knownHostsFile: config.data.GATEWAY_OBSERVER_KNOWN_HOSTS_FILE,
        remoteCommand: config.data.GATEWAY_OBSERVER_COMMAND,
        // The guest observation runs over a second SSH hop inside the forced
        // command, so it needs more headroom than a single-hop observer.
        executionTimeoutMs: 45_000,
    }));
}








// -----------------------------------------------------------
// createGatewayApplier
// -----------------------------------------------------------
//
// The applier throws when unconfigured rather than
// returning null. Every caller is an explicit mutation
// request, so silently doing nothing would be worse than
// refusing.
//
// Used by:
//   - provisioning-network.ts, teardown.ts,
//     drift-reconciler.ts, scripts/applyGatewayPolicy.ts
// -----------------------------------------------------------

export function createGatewayApplier(
    environment: NodeJS.ProcessEnv = process.env,
): GatewayApplyClient {
    const config = applierConfigSchema.safeParse(environment);
    if (!config.success) {
        throw new GatewayClientConfigurationError(
            `Gateway applier is not configured: ${
                config.error.issues.map((issue) => issue.path.join(".")).join(", ")
            }`,
        );
    }
    return new RestrictedSshGatewayApplyClient(new RestrictedSshTransport({
        host: config.data.GATEWAY_APPLIER_HOST,
        port: config.data.GATEWAY_APPLIER_PORT,
        hostKeyAlias: config.data.GATEWAY_APPLIER_HOST_KEY_ALIAS,
        user: config.data.GATEWAY_APPLIER_USER,
        identityFile: config.data.GATEWAY_APPLIER_IDENTITY_FILE,
        knownHostsFile: config.data.GATEWAY_APPLIER_KNOWN_HOSTS_FILE,
        remoteCommand: config.data.GATEWAY_APPLIER_COMMAND,
        // Staging restarts Squid and reloads nftables on the guest, over two SSH
        // hops. The guest's own rollback timer bounds the damage if this is cut
        // short, so a generous ceiling is safer than a premature abort.
        executionTimeoutMs: 180_000,
        // A stage request carries the whole rendered configuration.
        maxOutputBytes: 512 * 1024,
    }));
}
