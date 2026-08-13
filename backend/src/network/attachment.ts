import { NetworkGroup } from "@/types/network-groups";
import { networkProjectionConfig } from "./config";
import {
    allocateNetworkGroup,
    deleteUnusedPlannedGroup,
    markNetworkGroupError,
} from "./groups";
import { NetworkMode } from "./mode";

export class NetworkAttachmentError extends Error {}

/**
 * The Proxmox bridge a VM should be attached to, together with the group whose
 * policy identity owns it.
 *
 * `isolated` distinguishes a reserved per-group VNet from the shared legacy
 * bridge. It drives compensation, because only an allocated group holds a VLAN
 * and subnet that must survive a failure.
 */
export type NetworkAttachment = {
    bridge: string;
    group: NetworkGroup;
    isolated: boolean;
};

export type NetworkAttachmentDependencies = {
    allocate?: (groupId: number) => Promise<NetworkGroup>;
    releasePlanned?: (groupId: number) => Promise<void>;
    recordError?: (groupId: number, lastError: string) => Promise<void>;
};

/**
 * Resolves the network a new VM attaches to for the current network mode.
 *
 * `legacy` and `dry-run` keep the group `planned` and provision on the shared
 * legacy bridge, so neither reserves a VLAN or subnet. Only `active` promotes
 * the group and claims its canonical allocation.
 */
export async function resolveNetworkAttachment(
    mode: NetworkMode,
    group: NetworkGroup,
    dependencies: NetworkAttachmentDependencies = {},
): Promise<NetworkAttachment> {
    if (mode !== "active") {
        return {
            bridge: networkProjectionConfig.proxmox.bridge,
            group,
            isolated: false,
        };
    }

    const allocate = dependencies.allocate ?? allocateNetworkGroup;
    const allocated = await allocate(group.id);
    if (!allocated.vnet_name) {
        throw new NetworkAttachmentError(
            `Network group ${group.id} was allocated without a VNet name`,
        );
    }
    if (allocated.state !== "creating" && allocated.state !== "active") {
        throw new NetworkAttachmentError(
            `Network group ${group.id} is ${allocated.state} and cannot accept a VM`,
        );
    }

    return { bridge: allocated.vnet_name, group: allocated, isolated: true };
}

/**
 * Undoes the group side of a failed provisioning attempt.
 *
 * An unallocated group is removed when nothing else uses it. An allocated group
 * is only marked `error`; releasing its VLAN here could hand a subnet to another
 * owner while Proxmox resources from the failed attempt still reference it.
 */
export async function compensateNetworkAttachment(
    attachment: NetworkAttachment,
    lastError: string,
    dependencies: NetworkAttachmentDependencies = {},
): Promise<void> {
    if (!attachment.isolated) {
        const releasePlanned = dependencies.releasePlanned ?? deleteUnusedPlannedGroup;
        await releasePlanned(attachment.group.id);
        return;
    }

    const recordError = dependencies.recordError ?? markNetworkGroupError;
    await recordError(attachment.group.id, lastError);
}
