import { ProxmoxFirewallIpSetEntryInput, ProxmoxFirewallRuleInput } from "@/proxmox/types";
import {
    observeVmFirewall,
    planVmFirewall,
    VmFirewallObservationClient,
} from "./adapters/proxmox-vm-firewall";
import { VmFirewallPolicy, VM_FIREWALL_IPSET } from "./vm-firewall";

export class VmFirewallApplyError extends Error {
    constructor(message: string, readonly stage: "apply" | "verify") {
        super(message);
        this.name = "VmFirewallApplyError";
    }
}

export interface VmFirewallMutationClient {
    updateVmFirewallOptions(vmid: string, input: Record<string, unknown>): Promise<void>;
    getVmFirewallRules(vmid: string): Promise<{ pos: number }[]>;
    createVmFirewallRule(vmid: string, input: ProxmoxFirewallRuleInput): Promise<void>;
    deleteVmFirewallRule(vmid: string, position: number): Promise<void>;
    getVmFirewallIpSets(vmid: string): Promise<{ name: string }[]>;
    createVmFirewallIpSet(vmid: string, input: { name: string; comment?: string }): Promise<void>;
    getVmFirewallIpSetEntries(vmid: string, name: string): Promise<{ cidr: string }[]>;
    createVmFirewallIpSetEntry(
        vmid: string,
        name: string,
        input: ProxmoxFirewallIpSetEntryInput,
    ): Promise<void>;
    deleteVmFirewallIpSetEntry(vmid: string, name: string, cidr: string): Promise<void>;
}

export type VmFirewallApplyClient = VmFirewallMutationClient & VmFirewallObservationClient;

export type VmFirewallApplyResult = {
    vmid: string;
    revision: string;
    changed: boolean;
};

/**
 * Rewrites one VM's firewall to match its desired policy, then proves the result
 * by re-observing.
 *
 * Rules are replaced wholesale rather than diffed. Proxmox evaluates them in
 * order and stops at the first match, so a partial edit can leave an ACCEPT
 * ahead of a DROP and silently reopen what the DROP existed to close. Replacing
 * the list is the only edit whose result does not depend on what was there
 * before.
 *
 * That is safe here in a way it would not be for a VNet: this VM was created by
 * this system for one student, and its firewall has no meaning outside the
 * policy rendered for it. Nothing else is touched — no cluster rules, no other
 * guest, no security group.
 *
 * The source filter is applied BEFORE the ingress rules. Both orders converge,
 * but only this one is safe if the process dies in between: a VM that can send
 * only from its own address while its ingress is still open is strictly better
 * than one whose ingress is locked down while it can still claim any address on
 * the segment.
 */
export async function applyVmFirewall(
    policy: VmFirewallPolicy,
    client: VmFirewallApplyClient,
): Promise<VmFirewallApplyResult> {
    const before = await observeVmFirewall(client, policy.vmid);
    if (planVmFirewall(policy, before).no_change_required) {
        return { vmid: policy.vmid, revision: policy.revision, changed: false };
    }

    try {
        if (!(await client.getVmFirewallIpSets(policy.vmid))
            .some(({ name }) => name === VM_FIREWALL_IPSET)) {
            await client.createVmFirewallIpSet(policy.vmid, {
                name: VM_FIREWALL_IPSET,
                comment: "virtual-lab: source addresses this VM may send from",
            });
        }
        const existingEntries = await client.getVmFirewallIpSetEntries(
            policy.vmid,
            VM_FIREWALL_IPSET,
        );
        const desiredCidrs = new Set(policy.ipset.map(({ cidr }) => cidr));
        for (const { cidr } of existingEntries) {
            if (!desiredCidrs.has(cidr)) {
                await client.deleteVmFirewallIpSetEntry(policy.vmid, VM_FIREWALL_IPSET, cidr);
            }
        }
        const remaining = new Set(
            existingEntries.filter(({ cidr }) => desiredCidrs.has(cidr)).map(({ cidr }) => cidr),
        );
        for (const entry of policy.ipset) {
            // Recreated rather than updated when present, because an existing
            // entry may carry the wrong `nomatch` — and a stale `nomatch` on the
            // subnet entry would deny every address instead of two.
            if (remaining.has(entry.cidr)) {
                await client.deleteVmFirewallIpSetEntry(policy.vmid, VM_FIREWALL_IPSET, entry.cidr);
            }
            await client.createVmFirewallIpSetEntry(policy.vmid, VM_FIREWALL_IPSET, {
                cidr: entry.cidr,
                nomatch: entry.nomatch,
                comment: entry.comment,
            });
        }

        // Deleted from the highest position down: Proxmox renumbers on every
        // delete, so ascending order would skip every second rule.
        const existingRules = await client.getVmFirewallRules(policy.vmid);
        for (const { pos } of [...existingRules].sort((left, right) => right.pos - left.pos)) {
            await client.deleteVmFirewallRule(policy.vmid, pos);
        }
        // Created in reverse, because a POST without an explicit position
        // inserts at the top. Writing the list backwards therefore leaves it in
        // the intended order.
        for (const rule of [...policy.rules].reverse()) {
            await client.createVmFirewallRule(policy.vmid, rule);
        }

        // Options last. `enable` is in here, so until this call the guest
        // firewall is inert and a half-written ruleset filters nothing rather
        // than filtering wrongly.
        await client.updateVmFirewallOptions(policy.vmid, { ...policy.options });
    } catch (error) {
        throw new VmFirewallApplyError(
            `VM ${policy.vmid} firewall could not be written: ${
                error instanceof Error ? error.message : "unknown failure"
            }`,
            "apply",
        );
    }

    const after = planVmFirewall(policy, await observeVmFirewall(client, policy.vmid));
    if (!after.no_change_required) {
        throw new VmFirewallApplyError(
            `VM ${policy.vmid} firewall did not converge: ${
                after.checks
                    .filter((check) => check.status !== "pass")
                    .map((check) => check.detail)
                    .join("; ")
            }`,
            "verify",
        );
    }
    return { vmid: policy.vmid, revision: policy.revision, changed: true };
}
