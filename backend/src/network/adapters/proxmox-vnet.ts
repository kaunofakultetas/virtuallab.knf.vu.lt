import { ProxmoxSdnVnet, ProxmoxSdnZone } from "@/proxmox/types";
import { InfrastructurePlan } from "../infrastructure-desired-state";
import { ReconciliationDryRun } from "../reconciliation-types";

export interface ProxmoxVnetObservationClient {
    getSdnZones(): Promise<ProxmoxSdnZone[]>;
    getSdnVnets(): Promise<ProxmoxSdnVnet[]>;
}

export type ProxmoxVnetObservation = {
    zones: ProxmoxSdnZone[];
    vnets: ProxmoxSdnVnet[];
};

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