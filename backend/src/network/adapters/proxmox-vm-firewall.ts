import {
    ProxmoxFirewallIpSetEntry,
    ProxmoxFirewallOptions,
    ProxmoxFirewallRule,
    ProxmoxFirewallRuleInput,
} from "@/proxmox/types";
import { VmFirewallIpSetEntry, VmFirewallPolicy, VM_FIREWALL_IPSET } from "../vm-firewall";
import { ReconciliationCheck, ReconciliationDryRun } from "../reconciliation-types";

export type VmFirewallObservation = {
    vmid: string;
    options: ProxmoxFirewallOptions;
    rules: ProxmoxFirewallRule[];
    /** Null when the guest holds no ipfilter set at all, which is not the same
     *  as holding an empty one: an empty set drops every packet the VM sends. */
    ipset: ProxmoxFirewallIpSetEntry[] | null;
};

export interface VmFirewallObservationClient {
    getVmFirewallOptions(vmid: string): Promise<ProxmoxFirewallOptions>;
    getVmFirewallRules(vmid: string): Promise<ProxmoxFirewallRule[]>;
    getVmFirewallIpSets(vmid: string): Promise<{ name: string }[]>;
    getVmFirewallIpSetEntries(vmid: string, name: string): Promise<ProxmoxFirewallIpSetEntry[]>;
}

export async function observeVmFirewall(
    client: VmFirewallObservationClient,
    vmid: string,
): Promise<VmFirewallObservation> {
    const [options, rules, sets] = await Promise.all([
        client.getVmFirewallOptions(vmid),
        client.getVmFirewallRules(vmid),
        client.getVmFirewallIpSets(vmid),
    ]);
    const present = sets.some(({ name }) => name === VM_FIREWALL_IPSET);
    return {
        vmid,
        options,
        rules,
        ipset: present ? await client.getVmFirewallIpSetEntries(vmid, VM_FIREWALL_IPSET) : null,
    };
}

/**
 * Proxmox reports booleans as 0/1 and omits a field entirely when it has never
 * been set, so an absent value is compared as "not what we asked for" rather
 * than defaulted. Defaulting would let a VM that was never configured read as
 * configured.
 */
function sameFlag(observed: number | undefined, desired: boolean): boolean {
    return observed !== undefined && (observed === 1) === desired;
}

function optionDrift(policy: VmFirewallPolicy, observed: ProxmoxFirewallOptions): string[] {
    const drift: string[] = [];
    const flags: [keyof ProxmoxFirewallOptions & keyof VmFirewallPolicy["options"], boolean][] = [
        ["enable", policy.options.enable],
        ["dhcp", policy.options.dhcp],
        ["ipfilter", policy.options.ipfilter],
        ["macfilter", policy.options.macfilter],
        ["ndp", policy.options.ndp],
        ["radv", policy.options.radv],
    ];
    for (const [name, desired] of flags) {
        if (!sameFlag(observed[name] as number | undefined, desired)) {
            drift.push(`${name}=${observed[name] ?? "unset"}, expected ${desired ? 1 : 0}`);
        }
    }
    for (const name of ["policy_in", "policy_out"] as const) {
        if (observed[name] !== policy.options[name]) {
            drift.push(`${name}=${observed[name] ?? "unset"}, expected ${policy.options[name]}`);
        }
    }
    return drift;
}

function normalizeRule(rule: ProxmoxFirewallRule | ProxmoxFirewallRuleInput): string {
    // Compared field by field rather than by a marker comment: a rule that
    // matches ours in every field IS ours, and one that does not is drift no
    // matter what its comment claims.
    const enable = "enable" in rule ? rule.enable : undefined;
    return JSON.stringify({
        type: rule.type,
        action: rule.action,
        source: rule.source ?? null,
        dest: rule.dest ?? null,
        proto: rule.proto ?? null,
        sport: rule.sport ?? null,
        dport: rule.dport ?? null,
        // Proxmox reports 1/0; the desired side carries a boolean.
        enable: enable === undefined ? true : Boolean(enable),
    });
}

function normalizeIpSetEntry(
    entry: ProxmoxFirewallIpSetEntry | VmFirewallIpSetEntry,
): string {
    const nomatch = "nomatch" in entry ? entry.nomatch : undefined;
    // Proxmox stores a single address bare and reports it back without the
    // prefix, so `10.200.0.1/32` and `10.200.0.1` are the same entry. Comparing
    // them literally would report permanent drift on a converged VM.
    return JSON.stringify({
        cidr: entry.cidr.replace(/\/32$/, ""),
        nomatch: Boolean(nomatch),
    });
}

export type VmFirewallPlan = ReconciliationDryRun & {
    /** True when nothing needs writing, so an apply can return without mutating. */
    no_change_required: boolean;
};

/**
 * Grades a VM's live firewall against its desired policy.
 *
 * Rule *order* is compared, not just membership: Proxmox evaluates top-down and
 * stops at the first match, so the same rules in a different order can mean
 * something entirely different — an ACCEPT ahead of a DROP silently reopens what
 * the DROP was there to close.
 */
export function planVmFirewall(
    policy: VmFirewallPolicy,
    observation: VmFirewallObservation,
): VmFirewallPlan {
    if (policy.vmid !== observation.vmid) {
        throw new Error(
            `VM firewall observation is for ${observation.vmid}, expected ${policy.vmid}`,
        );
    }
    const options = optionDrift(policy, observation.options);
    const desiredRules = policy.rules.map(normalizeRule);
    const observedRules = observation.rules.map(normalizeRule);
    const rulesMatch = desiredRules.length === observedRules.length
        && desiredRules.every((rule, index) => rule === observedRules[index]);

    const desiredEntries = policy.ipset.map(normalizeIpSetEntry).sort();
    const observedEntries = (observation.ipset ?? []).map(normalizeIpSetEntry).sort();
    const ipsetMatch = observation.ipset !== null
        && desiredEntries.length === observedEntries.length
        && desiredEntries.every((entry, index) => entry === observedEntries[index]);

    const checks: ReconciliationCheck[] = [
        {
            key: `vm-firewall-options-${policy.vmid}`,
            component: "firewall",
            status: options.length === 0 ? "pass" : "fail",
            required: true,
            detail: options.length === 0
                ? "Guest firewall options match desired state"
                : `Option drift: ${options.join("; ")}`,
        },
        {
            key: `vm-firewall-rules-${policy.vmid}`,
            component: "firewall",
            status: rulesMatch ? "pass" : "fail",
            required: true,
            detail: rulesMatch
                ? `${policy.rules.length} rule(s) match desired state, in order`
                : `Expected ${policy.rules.length} rule(s) in order, observed ${observation.rules.length}`,
        },
        {
            key: `vm-firewall-ipfilter-${policy.vmid}`,
            component: "firewall",
            status: ipsetMatch ? "pass" : "fail",
            required: true,
            detail: observation.ipset === null
                ? `${VM_FIREWALL_IPSET} is absent, so ipfilter would drop every packet the VM sends`
                : ipsetMatch
                    ? `${policy.ipset.length} source filter entr(ies) match desired state`
                    : `Expected ${policy.ipset.length} source filter entr(ies), observed ${observation.ipset.length}`,
        },
    ];

    const noChange = options.length === 0 && rulesMatch && ipsetMatch;
    return {
        checks,
        actions: noChange ? [] : [{
            component: "firewall",
            operation: "update",
            execution_state: "planned",
            resource: `qemu/${policy.vmid}/firewall`,
            desired: { revision: policy.revision },
        }],
        no_change_required: noChange,
    };
}
