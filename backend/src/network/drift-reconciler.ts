import { NetworkGroup } from "@/types/network-groups";
import { pool } from "@/utils/db";
import { logger } from "@/utils/logger";
import { AccessApplyRunner, ACCESS_APPLY_FIXABLE_CHECKS } from "./access-apply-runner";
import {
    createAccessApplier,
    createAccessObserver,
    createAccessTrunkApplier,
} from "./access-clients";
import { AccessTrunkApplyRunner } from "./access-trunk-runner";
import { planAccess } from "./adapters/access";
import { planGateway } from "./adapters/gateway";
import { GatewayApplyRunner, GATEWAY_APPLY_FIXABLE_CHECKS } from "./gateway-apply-runner";
import { createGatewayApplier, createGatewayObserver } from "./gateway-clients";
import { getGatewayPlan } from "./gateway-plan";
import { getInfrastructurePlan } from "./infrastructure-desired-state";
import { getNetworkMode, NetworkMode } from "./mode";
import { buildAccessTrunkPlan } from "./access-trunk-runner";
import { getNetworkSlot } from "./config";
import { getPeerSubnetCidrs } from "./gateway-plan";
import { observeVmFirewall, planVmFirewall } from "./adapters/proxmox-vm-firewall";
import { applyVmFirewall, VmFirewallApplyClient } from "./vm-firewall-apply";
import { buildVmFirewallPolicy, sessionPortsForTemplate } from "./vm-firewall";
import { ReconciliationAttempt, ReconciliationLockedError } from "./reconciliation-attempts";

export type DriftComponent = "gateway-policy" | "access-policy" | "access-trunk" | "vm-firewall";

export type DriftReconciliationReport = {
    ran: boolean;
    reason?: string;
    /** Components observed to have drifted, whether or not repair succeeded. */
    drifted: DriftComponent[];
    repaired: DriftComponent[];
    failed: { component: DriftComponent; detail: string }[];
};

export type DriftReconcilerDependencies = {
    getMode?: () => Promise<NetworkMode>;
    observeGateway?: () => Promise<{ drifted: boolean; detail: string }>;
    observeAccess?: () => Promise<{ policyDrifted: boolean; trunkDrifted: boolean; detail: string }>;
    /** Instances whose per-VM firewall no longer matches its rendered policy. */
    observeVmFirewalls?: () => Promise<{ drifted: string[]; detail: string }>;
    repair?: Partial<Record<DriftComponent, () => Promise<ReconciliationAttempt>>>;
    repairVmFirewalls?: (vmids: string[]) => Promise<{ repaired: string[]; failed: string[] }>;
};

/**
 * Observes first, repairs only what actually drifted.
 *
 * This runs on a timer, which makes "apply unconditionally" the wrong shape: a
 * Gateway apply restarts Squid and dnsmasq and a rollback timer is armed each
 * time, so an unconditional pass would interrupt every student's session on a
 * schedule in order to write files that were already correct. Observation is
 * cheap and read-only; repair is not.
 *
 * Only *fixable* drift triggers a repair — the same sets the two apply runners
 * use to decide what blocks. A failing `gateway-uplink-connected` or
 * `access-live-veth` describes hypervisor state no amount of file writing
 * corrects, so re-applying against it would fail on a loop and fill the attempt
 * log with noise that hides the real problem.
 *
 * Every repair goes through the normal runner, so it takes the shared advisory
 * lock and records an attempt. A provisioning or teardown request already
 * holding that lock makes this pass skip rather than queue, which is correct:
 * whatever holds the lock is converging the same desired state anyway.
 */
export async function reconcileNetworkDrift(
    requestedBy: string,
    dependencies: DriftReconcilerDependencies = {},
): Promise<DriftReconciliationReport> {
    const empty = { drifted: [], repaired: [], failed: [] };
    const mode = await (dependencies.getMode ?? getNetworkMode)();
    if (mode !== "active") {
        return { ran: false, reason: `network mode is ${mode}`, ...empty };
    }

    const drifted: DriftComponent[] = [];
    const repaired: DriftComponent[] = [];
    const failed: { component: DriftComponent; detail: string }[] = [];

    const gateway = await (dependencies.observeGateway ?? observeGatewayDrift)();
    if (gateway.drifted) drifted.push("gateway-policy");

    const access = await (dependencies.observeAccess ?? observeAccessDrift)();
    if (access.policyDrifted) drifted.push("access-policy");
    if (access.trunkDrifted) drifted.push("access-trunk");

    // Per-VM firewalls are rendered from the group's peer list, which an admin
    // can change long after the VM was provisioned. Nothing else re-applies
    // them, so without this a new peering would open the Gateway's forward path
    // while every target VM went on dropping the traffic at `policy_in DROP` --
    // an approved pair that half works, which is the worst of the three states.
    const firewalls = await (dependencies.observeVmFirewalls ?? observeVmFirewallDrift)();
    if (firewalls.drifted.length > 0) drifted.push("vm-firewall");

    if (drifted.length === 0) {
        return { ran: true, ...empty };
    }
    logger.warn(
        {
            drifted,
            gateway: gateway.detail,
            access: access.detail,
            vmFirewalls: firewalls.detail,
        },
        "Network drift detected; repairing",
    );

    // Trunk first, then the guest policies, matching provisioning order: an
    // Access VLAN interface on a trunk that does not carry its VLAN passes no
    // frames, so repairing the policy while the trunk is still wrong would
    // converge onto something that still does not work.
    const order: DriftComponent[] = [
        "access-trunk",
        "access-policy",
        "gateway-policy",
        "vm-firewall",
    ];
    for (const component of order) {
        if (!drifted.includes(component)) continue;
        // Per-VM firewalls are not a single reconciliation attempt: each VM is
        // its own independent write, and one unreachable guest must not stop the
        // others from being repaired.
        if (component === "vm-firewall") {
            const outcome = await (
                dependencies.repairVmFirewalls ?? repairVmFirewalls
            )(firewalls.drifted);
            if (outcome.repaired.length > 0) repaired.push("vm-firewall");
            for (const vmid of outcome.failed) {
                failed.push({ component, detail: `VM ${vmid} firewall could not be repaired` });
            }
            continue;
        }
        try {
            const repair = dependencies.repair?.[component] ?? defaultRepairs[component];
            const attempt = await repair(requestedBy);
            if (attempt.status === "succeeded") {
                repaired.push(component);
            } else {
                failed.push({
                    component,
                    detail: `attempt ${attempt.id} finished ${attempt.status}`
                        + `${attempt.error_code ? ` (${attempt.error_code})` : ""}`,
                });
            }
        } catch (error) {
            if (error instanceof ReconciliationLockedError) {
                // Something else is converging the same desired state. Not a
                // failure, and retrying now would only contend for the lock.
                return {
                    ran: false,
                    reason: "reconciliation is already running",
                    drifted,
                    repaired,
                    failed,
                };
            }
            failed.push({
                component,
                detail: error instanceof Error ? error.message : "unknown failure",
            });
        }
    }

    return { ran: true, drifted, repaired, failed };
}

/**
 * The shared Proxmox client, resolved on first use rather than at import.
 *
 * Constructing it reads Proxmox environment variables, and this module is
 * imported by unit tests that inject every dependency and never reach Proxmox
 * at all. A module-scope import would make those tests fail on configuration
 * they have no reason to carry.
 */
let cachedFirewallClient: VmFirewallApplyClient | null = null;

async function firewallClient(): Promise<VmFirewallApplyClient> {
    if (!cachedFirewallClient) {
        const { proxmox } = await import("@/proxmox");
        cachedFirewallClient = proxmox as unknown as VmFirewallApplyClient;
    }
    return cachedFirewallClient;
}

type FirewallTarget = {
    proxmox_id: string;
    group_id: number;
    connection_type: string | null;
    connection_config: unknown;
};

/**
 * Every running instance on an allocated group, with the template facts its
 * policy is rendered from.
 *
 * Joined rather than fetched per instance so the whole sweep is one query: this
 * runs on a timer against every VM in the lab, and N round trips would make the
 * observation cost grow with the class size.
 */
const FIREWALL_TARGETS_SQL = `
    SELECT instance.proxmox_id,
           network_group.id AS group_id,
           template.connection_type::text AS connection_type,
           template.connection_config
    FROM instances instance
    JOIN network_groups network_group ON network_group.id = instance.network_group_id
    LEFT JOIN templates template ON template.id = instance.template_id
    WHERE network_group.vlan_tag IS NOT NULL
      -- 'error' included deliberately: an errored group keeps its allocation
      -- and its running VMs, and every other desired-state query treats it as
      -- operational. Excluding it here meant the only mechanism that
      -- re-converges per-VM policy silently skipped those VMs -- so a peering
      -- change would reach the Gateway and never reach them.
      AND network_group.state IN ('creating', 'active', 'error')
    ORDER BY instance.proxmox_id
`;

async function firewallTargets(): Promise<FirewallTarget[]> {
    return (await pool.query<FirewallTarget>(FIREWALL_TARGETS_SQL)).rows;
}

async function observeVmFirewallDrift(): Promise<{ drifted: string[]; detail: string }> {
    const drifted: string[] = [];
    const unreadable: string[] = [];
    for (const target of await firewallTargets()) {
        try {
            const plan = await planInstanceFirewall(target);
            if (!plan.no_change_required) drifted.push(target.proxmox_id);
        } catch {
            // An unreadable guest is not drift: reporting it as such would make
            // the reconciler rewrite a firewall it could not compare, on a timer.
            unreadable.push(target.proxmox_id);
        }
    }
    return {
        drifted,
        detail: [
            drifted.length ? `drifted: ${drifted.join(", ")}` : "all VM firewalls converged",
            unreadable.length ? `unreadable: ${unreadable.join(", ")}` : "",
        ].filter(Boolean).join("; "),
    };
}

async function planInstanceFirewall(target: FirewallTarget) {
    const group = (await pool.query<NetworkGroup>(
        "SELECT * FROM network_groups WHERE id = $1",
        [target.group_id],
    )).rows[0];
    const slot = getNetworkSlot(group.vlan_tag!);
    const policy = buildVmFirewallPolicy({
        vmid: target.proxmox_id,
        subnet_cidr: slot.subnetCidr,
        gateway_ip: slot.gatewayIp,
        access_ip: slot.accessIp,
        session_ports: sessionPortsForTemplate(
            target.connection_type as never,
            target.connection_config as never,
        ),
        peer_subnet_cidrs: await getPeerSubnetCidrs(group.id),
    });
    const client = await firewallClient();
    return { ...planVmFirewall(policy, await observeVmFirewall(client, target.proxmox_id)), policy };
}

async function repairVmFirewalls(
    vmids: string[],
): Promise<{ repaired: string[]; failed: string[] }> {
    const repaired: string[] = [];
    const failed: string[] = [];
    const targets = (await firewallTargets()).filter(
        (target) => vmids.includes(target.proxmox_id),
    );
    for (const target of targets) {
        try {
            const { policy } = await planInstanceFirewall(target);
            await applyVmFirewall(policy, await firewallClient());
            repaired.push(target.proxmox_id);
        } catch (error) {
            logger.error(
                { err: error, vmid: target.proxmox_id },
                "Failed to repair a VM firewall",
            );
            failed.push(target.proxmox_id);
        }
    }
    return { repaired, failed };
}

async function observeGatewayDrift(): Promise<{ drifted: boolean; detail: string }> {
    const observe = createGatewayObserver();
    if (!observe) return { drifted: false, detail: "Gateway observation is not configured" };
    const plan = await getGatewayPlan();
    const failing = planGateway(plan, await observe.observe()).checks.filter((check) => (
        check.required && check.status !== "pass" && GATEWAY_APPLY_FIXABLE_CHECKS.has(check.key)
    ));
    return {
        drifted: failing.length > 0,
        detail: failing.map((check) => check.key).join(", ") || "converged",
    };
}

async function observeAccessDrift(): Promise<{
    policyDrifted: boolean;
    trunkDrifted: boolean;
    detail: string;
}> {
    const observation = await createAccessObserver().observe();
    const infrastructure = await getInfrastructurePlan();
    const failing = planAccess(infrastructure, observation).checks.filter((check) => (
        check.required && check.status !== "pass" && ACCESS_APPLY_FIXABLE_CHECKS.has(check.key)
    ));
    // Graded from the same observation rather than a second round trip, so the
    // trunk and the policy can never be judged against two different moments.
    const trunk = buildAccessTrunkPlan(infrastructure, observation);
    return {
        policyDrifted: failing.length > 0,
        trunkDrifted: !trunk.no_change_required && trunk.live.status !== "unobservable",
        detail: [
            failing.map((check) => check.key).join(", ") || "policy converged",
            trunk.no_change_required ? "trunk converged" : "trunk drifted",
        ].join("; "),
    };
}

// `vm-firewall` is absent by design: it is not a single reconciliation attempt
// and is dispatched separately above.
const defaultRepairs: Record<
    Exclude<DriftComponent, "vm-firewall">,
    (requestedBy: string) => Promise<ReconciliationAttempt>
> = {
    "gateway-policy": async (requestedBy) => {
        const observe = createGatewayObserver();
        if (!observe) throw new Error("Gateway observation is not configured");
        return new GatewayApplyRunner({
            database: pool,
            apply: createGatewayApplier(),
            observe,
        }).apply({ requestedBy, expectedRevision: (await getGatewayPlan()).revision });
    },
    "access-policy": async (requestedBy) => new AccessApplyRunner({
        database: pool,
        apply: createAccessApplier(),
        observe: createAccessObserver(),
    }).apply({ requestedBy, expectedRevision: (await getInfrastructurePlan()).revision }),
    "access-trunk": async (requestedBy) => new AccessTrunkApplyRunner({
        database: pool,
        apply: createAccessTrunkApplier(),
        observe: createAccessObserver(),
    }).apply({ requestedBy, expectedRevision: (await getInfrastructurePlan()).revision }),
};
