import { proxmox } from "@/proxmox";
import { NetworkGroup } from "@/types/network-groups";
import { ConnectionConfig, ConnectionType } from "@/types/templates";
import { getNetworkSlot } from "./config";
import { getPeerSubnetCidrs } from "./gateway-plan";
import { applyVmFirewall, VmFirewallApplyClient, VmFirewallApplyResult } from "./vm-firewall-apply";
import { buildVmFirewallPolicy, sessionPortsForTemplate, VmFirewallError } from "./vm-firewall";

export type EnsureInstanceFirewallInput = {
    /** Proxmox VMID of the freshly created student VM. */
    vmid: string;
    group: NetworkGroup;
    connectionType: ConnectionType | null | undefined;
    connectionConfig: ConnectionConfig | null | undefined;
    /**
     * The group's profile `allow_same_group`. Required from the caller rather
     * than looked up here: `input.group` carries only `profile_id`, and the one
     * caller already holds the profile row it created the group under.
     */
    allowSameGroup: boolean;
    /**
     * Subnets of explicitly peered groups. Read from `group_peerings` when the
     * caller does not supply them, because the Gateway routes peered traffic and
     * the VM would otherwise drop it at `policy_in DROP` -- an approved pair that
     * works in one layer and fails in the next.
     */
    peerSubnetCidrs?: string[];
};

export type EnsureInstanceFirewallDependencies = {
    client?: VmFirewallApplyClient;
};

/**
 * Applies same-segment policy to a newly created student VM.
 *
 * Uses the provisioning Proxmox token rather than the network mutator token, and
 * deliberately so: the mutator is scoped to `/sdn` and holds no VM permission at
 * all, which is the property that keeps network reconciliation unable to touch
 * guests. Guest firewall configuration is a VM-scoped operation belonging to the
 * same credential that cloned the VM in the first place.
 *
 * The addresses come from the canonical slot for the group's VLAN rather than
 * from anything observed, so a VM is never handed a policy derived from a value
 * the VM itself could influence.
 */
export async function ensureInstanceFirewall(
    input: EnsureInstanceFirewallInput,
    dependencies: EnsureInstanceFirewallDependencies = {},
): Promise<VmFirewallApplyResult> {
    if (input.group.vlan_tag === null || input.group.subnet_cidr === null) {
        throw new VmFirewallError(
            `Network group ${input.group.id} has no allocation, so no VM policy can be derived`,
        );
    }
    const slot = getNetworkSlot(input.group.vlan_tag);
    if (slot.subnetCidr !== input.group.subnet_cidr) {
        // The persisted subnet disagreeing with the VLAN's canonical slot means
        // one of them is wrong, and picking either would write a policy for a
        // network the VM is not on.
        throw new VmFirewallError(
            `Network group ${input.group.id} subnet ${input.group.subnet_cidr} `
            + `does not match VLAN ${input.group.vlan_tag}'s canonical ${slot.subnetCidr}`,
        );
    }

    const policy = buildVmFirewallPolicy({
        vmid: input.vmid,
        subnet_cidr: slot.subnetCidr,
        gateway_ip: slot.gatewayIp,
        access_ip: slot.accessIp,
        session_ports: sessionPortsForTemplate(input.connectionType, input.connectionConfig),
        peer_subnet_cidrs: input.peerSubnetCidrs ?? await getPeerSubnetCidrs(input.group.id),
        allow_same_group: input.allowSameGroup,
    });
    return applyVmFirewall(policy, dependencies.client ?? (proxmox as VmFirewallApplyClient));
}
