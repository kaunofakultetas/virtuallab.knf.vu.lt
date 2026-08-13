import {
    ProxmoxNodeTaskStatus,
    ProxmoxSdnVnet,
    ProxmoxSdnVnetCreate,
    ProxmoxSdnVnetUpdate,
    ProxmoxSdnZone,
    ProxmoxTaskWaitOptions,
} from "@/proxmox/types";
import { InfrastructurePlan, InfrastructureVnet } from "../infrastructure-desired-state";
import { ReconciliationDryRun } from "../reconciliation-types";

export interface ProxmoxVnetObservationClient {
    getSdnZones(): Promise<ProxmoxSdnZone[]>;
    getSdnVnets(): Promise<ProxmoxSdnVnet[]>;
}

export type ProxmoxVnetObservation = {
    zones: ProxmoxSdnZone[];
    vnets: ProxmoxSdnVnet[];
};

export interface ProxmoxVnetMutationClient {
    createSdnVnet(input: ProxmoxSdnVnetCreate): Promise<void>;
    updateSdnVnet(vnet: string, input: ProxmoxSdnVnetUpdate): Promise<void>;
    applySdnConfiguration(): Promise<string | null>;
    waitForTask(
        upid: string,
        options?: ProxmoxTaskWaitOptions,
    ): Promise<ProxmoxNodeTaskStatus>;
}

export type ProxmoxVnetMutationAction = {
    operation: "create" | "update";
    resource: string;
    desired: InfrastructureVnet;
};

export type ProxmoxVnetActionExecutionState = "applying" | "succeeded" | "failed";

export type ProxmoxVnetActionTransition = (
    action: ProxmoxVnetMutationAction,
    executionState: ProxmoxVnetActionExecutionState,
) => Promise<void>;

export type ProxmoxVnetPostApplyVerification = () => Promise<void>;

export async function executeProxmoxVnetActions(
    client: ProxmoxVnetMutationClient,
    actions: ProxmoxVnetMutationAction[],
    transition?: ProxmoxVnetActionTransition,
    verify?: ProxmoxVnetPostApplyVerification,
): Promise<void> {
    for (const action of actions) {
        if (action.resource !== action.desired.vnet) {
            throw new Error(`VNet action resource ${action.resource} does not match desired VNet`);
        }
    }
    if (actions.length === 0) return;

    const started: ProxmoxVnetMutationAction[] = [];
    try {
        for (const action of actions) {
            await transition?.(action, "applying");
            started.push(action);
            if (action.operation === "create") {
                await client.createSdnVnet(action.desired);
            } else {
                const { vnet, ...desired } = action.desired;
                await client.updateSdnVnet(vnet, desired);
            }
        }

        const upid = await client.applySdnConfiguration();
        if (upid) await client.waitForTask(upid);
        await verify?.();
        for (const action of actions) await transition?.(action, "succeeded");
    } catch (error) {
        for (const action of started) await transition?.(action, "failed");
        throw error;
    }
}

export async function observeProxmoxVnets(
    client: ProxmoxVnetObservationClient,
): Promise<ProxmoxVnetObservation> {
    const [zones, vnets] = await Promise.all([
        client.getSdnZones(),
        client.getSdnVnets(),
    ]);
    return { zones, vnets };
}

export function planProxmoxVnets(
    plan: InfrastructurePlan,
    observation: ProxmoxVnetObservation,
): ReconciliationDryRun {
    const desiredVnets = plan.desired_state.proxmox.vnets;
    const desiredZone = desiredVnets[0]?.zone ?? "labzone";
    const zone = observation.zones.find(({ zone: name }) => name === desiredZone);
    const checks: ReconciliationDryRun["checks"] = [{
        key: "proxmox-sdn-zone",
        component: "proxmox-vnet",
        status: zone ? "pass" : "fail",
        required: true,
        detail: zone
            ? `SDN zone ${desiredZone} is readable`
            : `SDN zone ${desiredZone} does not exist`,
        observed: zone,
    }];
    const actions: ReconciliationDryRun["actions"] = [];
    const observedByName = new Map(observation.vnets.map((vnet) => [vnet.vnet, vnet]));

    for (const desired of desiredVnets) {
        const observed = observedByName.get(desired.vnet);
        if (!observed) {
            checks.push({
                key: `proxmox-vnet-${desired.vnet}`,
                component: "proxmox-vnet",
                status: "fail",
                required: true,
                detail: `VNet ${desired.vnet} does not exist`,
            });
            actions.push({
                component: "proxmox-vnet",
                operation: "create",
                execution_state: "planned",
                resource: desired.vnet,
                desired,
            });
            continue;
        }

        const matches = observed.zone === desired.zone && observed.tag === desired.tag;
        checks.push({
            key: `proxmox-vnet-${desired.vnet}`,
            component: "proxmox-vnet",
            status: matches ? "pass" : "fail",
            required: true,
            detail: matches
                ? `VNet ${desired.vnet} matches zone ${desired.zone} and tag ${desired.tag}`
                : `VNet ${desired.vnet} does not match zone ${desired.zone} and tag ${desired.tag}`,
            observed,
        });
        if (!matches) {
            actions.push({
                component: "proxmox-vnet",
                operation: "update",
                execution_state: "planned",
                resource: desired.vnet,
                desired,
            });
        }
    }

    const desiredNames = new Set(desiredVnets.map(({ vnet }) => vnet));
    for (const observed of observation.vnets
        .filter(({ vnet }) => vnet.startsWith("lab") && !desiredNames.has(vnet))
        .sort((left, right) => left.vnet.localeCompare(right.vnet))) {
        checks.push({
            key: `proxmox-vnet-unowned-${observed.vnet}`,
            component: "proxmox-vnet",
            status: "fail",
            required: false,
            detail: `VNet ${observed.vnet} is not owned by the operational plan; no deletion is scheduled`,
            observed,
        });
    }

    return { checks, actions };
}