// -----------------------------------------------------------
//  [*] Network — making a group's VNet real in Proxmox
//
//  The VNet half of provisioning: full-desired-state VNet
//  reconciliation under the network mutator token, with a
//  bounded retry around concurrent revision changes.
//
//  Used by:
//    - provisioning-network.ts — the first infrastructure
//      step before a VM attaches
//    - test/provisioning-vnet.test.ts
// -----------------------------------------------------------

import { NetworkGroup } from "@/types/network-groups";
import { pool } from "@/utils/db";
import {
    InfrastructureApplyInput,
    InfrastructureApplyRevisionError,
    InfrastructureApplyRunner,
} from "./infrastructure-apply-runner";
import { getInfrastructurePlan, InfrastructurePlan } from "./infrastructure-desired-state";
import { createNetworkProxmoxMutator } from "./proxmox-clients";
import { ReconciliationAttempt } from "./reconciliation-attempts";

export class NetworkGroupVnetError extends Error {}

// How many times to re-read the plan when a concurrent allocation changes the
// desired revision between our read and the reconciliation lock.
export const VNET_APPLY_REVISION_ATTEMPTS = 3;

export type EnsureNetworkGroupVnetDependencies = {
    getPlan?: () => Promise<InfrastructurePlan>;
    applyVnets?: (input: InfrastructureApplyInput) => Promise<ReconciliationAttempt>;
    revisionAttempts?: number;
};








// -----------------------------------------------------------
// applyVnetsWithMutator
// -----------------------------------------------------------
//
// One runner invocation on a freshly built mutator client,
// closed whatever happens.
//
// Used by:
//   - ensureNetworkGroupVnet (below) — the default applier
// -----------------------------------------------------------

async function applyVnetsWithMutator(
    input: InfrastructureApplyInput,
): Promise<ReconciliationAttempt> {
    const proxmox = createNetworkProxmoxMutator();
    try {
        return await new InfrastructureApplyRunner({
            database: pool,
            proxmox,
        }).applyVnets(input);
    } finally {
        await proxmox.close();
    }
}








// -----------------------------------------------------------
// ensureNetworkGroupVnet
// -----------------------------------------------------------
//
// Makes an allocated group's SDN VNet exist in Proxmox
// before a VM attaches to it.
//
// Reconciliation stays full-desired-state rather than
// per-group: the runner plans every owned VNet, so this
// converges drift from earlier failures and is a no-op once
// everything matches.
//
// The runner requires an exact desired revision. A
// concurrent allocation can move that revision between our
// read and the reconciliation lock, so a bounded retry
// re-reads the plan instead of failing a provisioning
// request for a race that is already resolved.
//
// Used by:
//   - provisioning-network.ts
// -----------------------------------------------------------

export async function ensureNetworkGroupVnet(
    group: NetworkGroup,
    requestedBy: string,
    dependencies: EnsureNetworkGroupVnetDependencies = {},
): Promise<ReconciliationAttempt> {
    if (!group.vnet_name) {
        throw new NetworkGroupVnetError(
            `Network group ${group.id} has no VNet name to reconcile`,
        );
    }

    const getPlan = dependencies.getPlan ?? (() => getInfrastructurePlan());
    const applyVnets = dependencies.applyVnets ?? applyVnetsWithMutator;
    const revisionAttempts = dependencies.revisionAttempts ?? VNET_APPLY_REVISION_ATTEMPTS;

    let lastRevisionError: InfrastructureApplyRevisionError | undefined;
    for (let remaining = revisionAttempts; remaining > 0; remaining -= 1) {
        const plan = await getPlan();
        const owned = plan.desired_state.proxmox.vnets.some(
            ({ vnet }) => vnet === group.vnet_name,
        );
        if (!owned) {
            // The plan only contains operational groups, so a missing VNet means
            // the group is not in a state that may claim infrastructure.
            throw new NetworkGroupVnetError(
                `Network group ${group.id} is not part of the operational plan`,
            );
        }

        let attempt: ReconciliationAttempt;
        try {
            attempt = await applyVnets({ requestedBy, expectedRevision: plan.revision });
        } catch (error) {
            if (error instanceof InfrastructureApplyRevisionError) {
                lastRevisionError = error;
                continue;
            }
            throw error;
        }

        if (attempt.status !== "succeeded") {
            throw new NetworkGroupVnetError(
                `VNet reconciliation ${attempt.id} finished ${attempt.status}`
                + `${attempt.error_code ? ` (${attempt.error_code})` : ""}`,
            );
        }
        return attempt;
    }

    throw new NetworkGroupVnetError(
        `VNet reconciliation for network group ${group.id} could not settle on a`
        + ` desired revision after ${revisionAttempts} attempts`
        + `${lastRevisionError ? `: ${lastRevisionError.message}` : ""}`,
    );
}
