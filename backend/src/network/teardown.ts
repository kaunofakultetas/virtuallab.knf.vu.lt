// -----------------------------------------------------------
//  [*] Network — releasing a group: the teardown sequence
//
//  The exact inverse of provisioning, each step gated on
//  the one before:
//
//    1. guard          — refuse while any instance remains
//    2. mark deleting  — drops the group from every plan,
//                        so the prune steps below converge
//    3. delete VNet    — first, because it can still refuse
//                        ("something references it") and a
//                        refusal must come before anything
//                        else is dismantled
//    4. gateway-policy, access-policy, access-trunk — each
//       appliance loses its VLAN interface before the trunk
//       stops carrying the VLAN
//    5. release        — delete the row, freeing VLAN+subnet
//
//  A failure part-way leaves the group in `deleting` with
//  its allocation intact — deliberately: the VLAN stays out
//  of the pool until a retry has verified every resource is
//  gone. The failure reason is recorded on the row so the
//  operator is not sent to the logs.
//
//  Used by:
//    - network.route.ts — the release endpoint
//    - provisioning-teardown.ts — after a last-VM delete
//    - scripts/releaseNetworkGroup.ts — the operator CLI
//    - test/teardown.test.ts
// -----------------------------------------------------------

import { ProxmoxClient } from "@/proxmox/api";
import { NetworkGroup } from "@/types/network-groups";
import { pool } from "@/utils/db";
import { AccessApplyRunner, AccessApplyRevisionError } from "./access-apply-runner";
import {
    createAccessApplier,
    createAccessObserver,
    createAccessTrunkApplier,
} from "./access-clients";
import { AccessTrunkApplyRunner, AccessTrunkRevisionError } from "./access-trunk-runner";
import { GatewayApplyRevisionError, GatewayApplyRunner } from "./gateway-apply-runner";
import { createGatewayApplier, createGatewayObserver } from "./gateway-clients";
import { getGatewayPlan } from "./gateway-plan";
import {
    deleteNetworkGroupRecord,
    markNetworkGroupDeleting,
    markNetworkGroupTeardownError,
} from "./groups";
import { getInfrastructurePlan } from "./infrastructure-desired-state";
import { getNetworkMode, NetworkMode } from "./mode";
import { createNetworkProxmoxMutator } from "./proxmox-clients";
import {
    ReconciliationAttempt,
    ReconciliationLockedError,
} from "./reconciliation-attempts";

export class NetworkTeardownError extends Error {
    constructor(readonly step: NetworkTeardownStep, message: string) {
        super(`Network teardown failed at ${step}: ${message}`);
        this.name = "NetworkTeardownError";
    }
}

export type NetworkTeardownStep =
    | "guard"
    | "vnet"
    | "gateway-policy"
    | "access-policy"
    | "access-trunk"
    | "release";

export type NetworkTeardownOutcome =
    // The group still has VMs, or is not in a state that may be torn down.
    | { released: false; reason: string }
    | { released: true; vlan_tag: number; vnet_name: string; steps: string[] };

export const TEARDOWN_REVISION_ATTEMPTS = 3;

// How long to wait before re-reading the revision after a conflict.
//
// Without this the three attempts were a tight loop with a bare `continue`, so
// the whole budget was spent inside a millisecond. Both things it retries --
// a held reconciliation lock and a moved revision -- are cleared by *another*
// operation finishing, and those take appliance time, not CPU time. Retrying
// instantly against a lock held for the length of a Gateway apply meant three
// attempts were only ever worth one, and teardown failed at `gateway-policy`
// whenever the ten-minute drift sweep happened to be mid-repair.
export const TEARDOWN_REVISION_RETRY_MS = 3_000;

export type NetworkTeardownDependencies = {
    getMode?: () => Promise<NetworkMode>;
    markDeleting?: (groupId: number) => Promise<NetworkGroup | null>;
    deleteRecord?: (groupId: number) => Promise<boolean>;
    // Enumerates every guest NIC so a referenced VNet is never removed.
    findVnetReferences?: (vnetName: string) => Promise<string[]>;
    deleteVnet?: (vnetName: string) => Promise<void>;
    reconcileGatewayPolicy?: (input: RevisionedApply) => Promise<ReconciliationAttempt>;
    reconcileAccessPolicy?: (input: RevisionedApply) => Promise<ReconciliationAttempt>;
    reconcileAccessTrunk?: (input: RevisionedApply) => Promise<ReconciliationAttempt>;
    infrastructureRevision?: () => Promise<string>;
    gatewayRevision?: () => Promise<string>;
    revisionAttempts?: number;
    // Annotates the stranded row with the reason teardown stopped.
    recordTeardownError?: (groupId: number, lastError: string) => Promise<void>;
    revisionRetryMs?: number;
    // Injected so the retry backoff costs tests nothing.
    sleep?: (milliseconds: number) => Promise<void>;
};

export type RevisionedApply = {
    requestedBy: string;
    expectedRevision: string;
};








// -----------------------------------------------------------
// findVnetReferencesInProxmox
// -----------------------------------------------------------
//
// Every guest whose NIC still names the VNet.
//
// Read from Proxmox rather than inferred from the database,
// because the database is authoritative for what *should*
// exist and this check exists precisely to catch what does.
// A VM created outside the orchestrator, or one whose
// instance row was lost, would be invisible to any query
// over `instances`.
//
// Used by:
//   - releaseNetworkGroup (below) — the guard step
// -----------------------------------------------------------

async function findVnetReferencesInProxmox(
    client: Pick<ProxmoxClient, "getVms" | "getVmConfig">,
    vnetName: string,
): Promise<string[]> {
    const referencing: string[] = [];
    for (const vm of await client.getVms()) {
        const config = await client.getVmConfig(String(vm.vmid));
        const referenced = Object.entries(config).some(([key, value]) => (
            /^net\d+$/.test(key)
            && typeof value === "string"
            // Anchored on the field boundary so `lab2000` never matches
            // `lab20001`, which would silently protect the wrong VNet.
            && new RegExp(`(^|,)bridge=${vnetName}(,|$)`).test(value)
        ));
        if (referenced) referencing.push(`qemu/${vm.vmid}`);
    }
    return referencing;
}








// -----------------------------------------------------------
// reconcile
// -----------------------------------------------------------
//
// One revision-guarded teardown step with a paced retry.
//
// A held reconciliation lock is retried alongside a
// revision conflict, and for the same reason: both mean
// "something else is converging this state right now", not
// "this teardown is wrong". Treating it as fatal aborted
// teardown AFTER the VNet was already deleted, leaving the
// group in `deleting` with no automatic path back —
// allocateNetworkGroup resumes `error`, never `deleting`.
//
// Used by:
//   - releaseNetworkGroup (below) — steps 4a-4c
// -----------------------------------------------------------

async function reconcile(
    step: NetworkTeardownStep,
    attempts: number,
    readRevision: () => Promise<string>,
    apply: (expectedRevision: string) => Promise<ReconciliationAttempt>,
    isRevisionConflict: (error: unknown) => boolean,
    retryMs: number,
    sleep: (milliseconds: number) => Promise<void>,
): Promise<string> {
    let lastConflict: unknown;
    for (let remaining = attempts; remaining > 0; remaining -= 1) {
        let attempt: ReconciliationAttempt;
        try {
            attempt = await apply(await readRevision());
        } catch (error) {
            if (isRevisionConflict(error) || error instanceof ReconciliationLockedError) {
                lastConflict = error;
                // No wait after the final attempt: the caller is about to fail
                // and sleeping first only delays the error.
                if (remaining > 1) await sleep(retryMs);
                continue;
            }
            throw new NetworkTeardownError(
                step,
                error instanceof Error ? error.message : "unknown failure",
            );
        }
        if (attempt.status !== "succeeded") {
            throw new NetworkTeardownError(
                step,
                `reconciliation ${attempt.id} finished ${attempt.status}`
                + `${attempt.error_code ? ` (${attempt.error_code})` : ""}`,
            );
        }
        return `${step}:${attempt.id}`;
    }
    throw new NetworkTeardownError(
        step,
        `could not settle on a desired revision after ${attempts} attempts`
        + `${lastConflict instanceof Error ? `: ${lastConflict.message}` : ""}`,
    );
}








// -----------------------------------------------------------
// deleteVnetWithMutator
// -----------------------------------------------------------
//
// Deletes the VNet through the network mutator, idempotently
// and verified — the two inline comments carry why both
// halves matter for a resumable teardown.
//
// Used by:
//   - releaseNetworkGroup (below) — the default deleteVnet
// -----------------------------------------------------------

async function deleteVnetWithMutator(vnetName: string): Promise<void> {
    const proxmox = createNetworkProxmoxMutator();
    try {
        // Absence is the goal, so an already-absent VNet is success. Teardown is
        // resumable by design, and a retry after a failure further down the
        // sequence arrives here with the VNet already gone -- issuing the DELETE
        // anyway turns a completed step into a 404 and blocks the retry forever.
        if ((await proxmox.getSdnVnets()).some(({ vnet }) => vnet === vnetName)) {
            await proxmox.deleteSdnVnet(vnetName);
            const upid = await proxmox.applySdnConfiguration();
            if (upid) await proxmox.waitForTask(upid);
        }
        // Verified rather than assumed: an SDN apply that reports success while
        // leaving the VNet behind would release the VLAN into the pool with a
        // live bridge still carrying its name.
        if ((await proxmox.getSdnVnets()).some(({ vnet }) => vnet === vnetName)) {
            throw new Error(`VNet ${vnetName} still exists after delete and apply`);
        }
    } finally {
        await proxmox.close();
    }
}








// -----------------------------------------------------------
// releaseNetworkGroup
// -----------------------------------------------------------
//
// The sequence in the file header. Refusals ({released:
// false}) are answers, not errors: wrong mode, no
// allocation, or instances still attached. Everything past
// markDeleting runs under the try that records the failure
// reason on the row.
//
// Used by:
//   - network.route.ts, provisioning-teardown.ts,
//     scripts/releaseNetworkGroup.ts
// -----------------------------------------------------------

export async function releaseNetworkGroup(
    group: NetworkGroup,
    requestedBy: string,
    dependencies: NetworkTeardownDependencies = {},
): Promise<NetworkTeardownOutcome> {
    const mode = await (dependencies.getMode ?? getNetworkMode)();
    if (mode !== "active") {
        return { released: false, reason: `network mode is ${mode}` };
    }
    if (group.vlan_tag === null || group.vnet_name === null) {
        // Nothing was ever allocated, so there is nothing to release and no
        // infrastructure to reconcile away.
        return { released: false, reason: "group holds no allocation" };
    }

    const attempts = dependencies.revisionAttempts ?? TEARDOWN_REVISION_ATTEMPTS;
    const retryMs = dependencies.revisionRetryMs ?? TEARDOWN_REVISION_RETRY_MS;
    const recordTeardownError = dependencies.recordTeardownError
        ?? markNetworkGroupTeardownError;
    const sleep = dependencies.sleep
        ?? ((milliseconds: number) => new Promise<void>((resolve) => {
            setTimeout(resolve, milliseconds);
        }));
    const markDeleting = dependencies.markDeleting ?? markNetworkGroupDeleting;
    const deleteRecord = dependencies.deleteRecord ?? deleteNetworkGroupRecord;
    const deleteVnet = dependencies.deleteVnet ?? deleteVnetWithMutator;
    const infrastructureRevision = dependencies.infrastructureRevision
        ?? (async () => (await getInfrastructurePlan()).revision);
    const gatewayRevision = dependencies.gatewayRevision
        ?? (async () => (await getGatewayPlan()).revision);
    const findReferences = dependencies.findVnetReferences
        ?? (async (vnetName: string) => {
            const proxmox = createNetworkProxmoxMutator();
            try {
                return await findVnetReferencesInProxmox(proxmox, vnetName);
            } finally {
                await proxmox.close();
            }
        });

    const marked = await markDeleting(group.id);
    if (!marked) {
        return { released: false, reason: "group still has instances or is not releasable" };
    }

    const steps: string[] = ["marked-deleting"];
    // Every failure past this point strands the group in `deleting` with its
    // allocation reserved -- deliberately, and safely, but silently. Recording
    // the reason on the row is what turns "state = deleting, last_error = NULL"
    // into something an operator can act on without going to the logs.
    try {
        try {
            const references = await findReferences(group.vnet_name);
            if (references.length > 0) {
                throw new NetworkTeardownError(
                    "guard",
                    `VNet ${group.vnet_name} is still referenced by ${references.join(", ")}`,
                );
            }
            await deleteVnet(group.vnet_name);
            steps.push(`vnet-deleted:${group.vnet_name}`);
        } catch (error) {
            if (error instanceof NetworkTeardownError) throw error;
            throw new NetworkTeardownError(
                "vnet",
                error instanceof Error ? error.message : "unknown failure",
            );
        }

        steps.push(await reconcile(
            "gateway-policy",
            attempts,
            gatewayRevision,
            (expectedRevision) => (
                dependencies.reconcileGatewayPolicy ?? defaultGatewayReconcile
            )({ requestedBy, expectedRevision }),
            (error) => error instanceof GatewayApplyRevisionError,
            retryMs,
            sleep,
        ));
        steps.push(await reconcile(
            "access-policy",
            attempts,
            infrastructureRevision,
            (expectedRevision) => (
                dependencies.reconcileAccessPolicy ?? defaultAccessPolicyReconcile
            )({ requestedBy, expectedRevision }),
            (error) => error instanceof AccessApplyRevisionError,
            retryMs,
            sleep,
        ));
        steps.push(await reconcile(
            "access-trunk",
            attempts,
            infrastructureRevision,
            (expectedRevision) => (
                dependencies.reconcileAccessTrunk ?? defaultAccessTrunkReconcile
            )({ requestedBy, expectedRevision }),
            (error) => error instanceof AccessTrunkRevisionError,
            retryMs,
            sleep,
        ));

        if (!await deleteRecord(group.id)) {
            // The row survived its guards, which means a VM attached during
            // teardown. Refusing here keeps the VLAN out of the pool.
            throw new NetworkTeardownError(
                "release",
                `group ${group.id} could not be released; it may have gained an instance`,
            );
        }
        steps.push("released");

        return {
            released: true,
            vlan_tag: group.vlan_tag,
            vnet_name: group.vnet_name,
            steps,
        };
    } catch (error) {
        await recordTeardownError(
            group.id,
            error instanceof Error ? error.message : "unknown teardown failure",
        );
        throw error;
    }
}








// -----------------------------------------------------------
// defaultGatewayReconcile / defaultAccessPolicyReconcile /
// defaultAccessTrunkReconcile
// -----------------------------------------------------------
//
// The production wiring of the three prune runners.
//
// Used by:
//   - releaseNetworkGroup (above) — the default appliers
// -----------------------------------------------------------

function defaultGatewayReconcile(input: RevisionedApply): Promise<ReconciliationAttempt> {
    const observe = createGatewayObserver();
    if (!observe) throw new Error("Gateway observation is not configured");
    return new GatewayApplyRunner({
        database: pool,
        apply: createGatewayApplier(),
        observe,
    }).apply(input);
}


function defaultAccessPolicyReconcile(input: RevisionedApply): Promise<ReconciliationAttempt> {
    return new AccessApplyRunner({
        database: pool,
        apply: createAccessApplier(),
        observe: createAccessObserver(),
    }).apply(input);
}


function defaultAccessTrunkReconcile(input: RevisionedApply): Promise<ReconciliationAttempt> {
    return new AccessTrunkApplyRunner({
        database: pool,
        apply: createAccessTrunkApplier(),
        observe: createAccessObserver(),
    }).apply(input);
}
