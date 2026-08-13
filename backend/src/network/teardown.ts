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
    /** The group still has VMs, or is not in a state that may be torn down. */
    | { released: false; reason: string }
    | { released: true; vlan_tag: number; vnet_name: string; steps: string[] };

export const TEARDOWN_REVISION_ATTEMPTS = 3;

export type NetworkTeardownDependencies = {
    getMode?: () => Promise<NetworkMode>;
    markDeleting?: (groupId: number) => Promise<NetworkGroup | null>;
    deleteRecord?: (groupId: number) => Promise<boolean>;
    /** Enumerates every guest NIC so a referenced VNet is never removed. */
    findVnetReferences?: (vnetName: string) => Promise<string[]>;
    deleteVnet?: (vnetName: string) => Promise<void>;
    reconcileGatewayPolicy?: (input: RevisionedApply) => Promise<ReconciliationAttempt>;
    reconcileAccessPolicy?: (input: RevisionedApply) => Promise<ReconciliationAttempt>;
    reconcileAccessTrunk?: (input: RevisionedApply) => Promise<ReconciliationAttempt>;
    infrastructureRevision?: () => Promise<string>;
    gatewayRevision?: () => Promise<string>;
    revisionAttempts?: number;
};

export type RevisionedApply = {
    requestedBy: string;
    expectedRevision: string;
};

/**
 * Every guest whose NIC still names the VNet.
 *
 * Read from Proxmox rather than inferred from the database, because the
 * database is authoritative for what *should* exist and this check exists
 * precisely to catch what does. A VM created outside the orchestrator, or one
 * whose instance row was lost, would be invisible to any query over `instances`.
 */
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

async function reconcile(
    step: NetworkTeardownStep,
    attempts: number,
    readRevision: () => Promise<string>,
    apply: (expectedRevision: string) => Promise<ReconciliationAttempt>,
    isRevisionConflict: (error: unknown) => boolean,
): Promise<string> {
    let lastConflict: unknown;
    for (let remaining = attempts; remaining > 0; remaining -= 1) {
        let attempt: ReconciliationAttempt;
        try {
            attempt = await apply(await readRevision());
        } catch (error) {
            // A held reconciliation lock is retried alongside a revision
            // conflict, and for the same reason: both mean "something else is
            // converging this state right now", not "this teardown is wrong".
            // Treating it as fatal aborted teardown AFTER the VNet was already
            // deleted, leaving the group in `deleting` with no automatic path
            // back -- allocateNetworkGroup resumes `error`, never `deleting`.
            if (isRevisionConflict(error) || error instanceof ReconciliationLockedError) {
                lastConflict = error;
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

/**
 * Releases a network group whose last VM has gone, freeing its VLAN and subnet.
 *
 * The order is the exact inverse of provisioning, and each step is gated on the
 * one before:
 *
 * 1. **Guard** — refuse while any instance still references the group. A group
 *    is never released because one of several attached VMs was removed.
 * 2. **Mark `deleting`** — which drops the group out of the infrastructure plan.
 *    Doing this first is what makes the prune steps converge: every renderer
 *    then projects a desired state without the VLAN, and the executors remove
 *    what is no longer wanted. It also stops a concurrent VNet apply recreating
 *    what step 3 is about to delete.
 * 3. **Delete the VNet** — before dismantling anything else, because this is the
 *    step that can still refuse ("something references it"), and failing here
 *    must not leave a group whose Gateway and Access configuration has already
 *    been torn down.
 * 4. **Gateway policy**, then **Access policy**, then **Access trunk** — the
 *    reverse of the provisioning order. Each appliance loses its VLAN interface
 *    before the trunk stops carrying the VLAN, so no interface is ever left
 *    attached to a trunk that cannot reach it.
 * 5. **Delete the row**, releasing the VLAN and subnet.
 *
 * A failure part-way through leaves the group in `deleting` with its allocation
 * intact. That is deliberate: the VLAN stays out of the pool until a retry has
 * verified every resource is gone, which is the same reason a failed
 * provisioning keeps its allocation.
 */
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
    ));
    steps.push(await reconcile(
        "access-policy",
        attempts,
        infrastructureRevision,
        (expectedRevision) => (
            dependencies.reconcileAccessPolicy ?? defaultAccessPolicyReconcile
        )({ requestedBy, expectedRevision }),
        (error) => error instanceof AccessApplyRevisionError,
    ));
    steps.push(await reconcile(
        "access-trunk",
        attempts,
        infrastructureRevision,
        (expectedRevision) => (
            dependencies.reconcileAccessTrunk ?? defaultAccessTrunkReconcile
        )({ requestedBy, expectedRevision }),
        (error) => error instanceof AccessTrunkRevisionError,
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
}

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
