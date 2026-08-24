import z from "zod";
import { randomUUID } from "node:crypto";
import { buildOperationalAccessPlan } from "../access-desired-state";
import { accessObservationSchema, compareAccessObservation } from "../access-observation";
import { InfrastructurePlan } from "../infrastructure-desired-state";
import { ReconciliationDryRun } from "../reconciliation-types";
import { RestrictedSshTransport } from "./restricted-ssh";

const vlanSchema = z.number().int().min(1).max(4094);

export const accessHostObservationSchema = z.object({
    version: z.literal(1),
    request_id: z.uuid(),
    target: z.literal("access"),
    operation: z.literal("observe"),
    captured_at: z.iso.datetime(),
    vmid: z.literal(200),
    status: z.literal("running"),
    config_digest: z.string().regex(/^[0-9a-f]{40}$/),
    net1: z.object({
        name: z.string().min(1),
        bridge: z.string().min(1),
        ip: z.string().min(1).nullable(),
        trunks: z.array(vlanSchema),
    }).strict(),
    host_veth: z.object({
        name: z.literal("veth200i1"),
        exists: z.boolean(),
        vlan_ids: z.array(vlanSchema),
    }).strict(),
    guest: accessObservationSchema,
    errors: z.array(z.string().max(500)).max(20),
}).strict();

export type AccessHostObservation = z.infer<typeof accessHostObservationSchema>;

export interface AccessObservationClient {
    observe(): Promise<AccessHostObservation>;
}

export class RestrictedSshAccessObservationClient implements AccessObservationClient {
    constructor(private readonly transport: Pick<RestrictedSshTransport, "execute">) {}

    async observe(): Promise<AccessHostObservation> {
        const requestId = randomUUID();
        const result = accessHostObservationSchema.parse(await this.transport.execute({
            version: 1,
            request_id: requestId,
            target: "access",
            operation: "observe",
        }));
        if (result.request_id !== requestId) {
            throw new Error("Access observer request ID does not match the request");
        }
        return result;
    }
}

/**
 * Whether the trunk carries every VLAN the plan wants, ignoring extras.
 *
 * Deliberately not set equality, and the asymmetry is the whole point.
 *
 * Teardown marks a group `deleting` before it touches any appliance, which drops
 * that group's VLAN out of `trunks.access_vlan_ids` while the Access appliance is
 * still physically carrying it. Under equality that makes both trunk checks fail,
 * and because they are `required` and absent from ACCESS_APPLY_FIXABLE_CHECKS
 * they block the Access policy apply outright -- which is the step teardown runs
 * *next*, and which runs BEFORE the trunk step that would have pruned the extra
 * VLAN. Teardown therefore manufactured the exact condition that blocked it, on
 * every allocated group, with no retry able to clear it.
 *
 * The two directions are not equally dangerous. A *missing* desired VLAN still
 * fails, and must: policy written for a VLAN the trunk cannot carry is policy
 * that silently never takes effect. An *extra* VLAN is inert -- once the group's
 * VNet and guest interface are gone nothing offers frames for it -- and it is
 * still reported and still pruned, because `access-trunk-persistent` and
 * `access-trunk-live` in access-trunk.ts compare by equality and are what the
 * trunk applier and the drift sweep actually act on.
 */
function sameVlans(left: number[], right: number[]): boolean {
    const canonical = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
    return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function carriesEveryVlan(observed: number[], desired: number[]): boolean {
    const present = new Set(observed);
    return desired.every((vlan) => present.has(vlan));
}

export function planAccess(
    infrastructurePlan: InfrastructurePlan,
    input: unknown,
): ReconciliationDryRun {
    const observation = accessHostObservationSchema.parse(input);
    const desiredTrunks = infrastructurePlan.desired_state.trunks.access_vlan_ids;
    const accessPlan = buildOperationalAccessPlan({
        groups: infrastructurePlan.desired_state.groups.map((group) => ({
            group_id: group.group_id,
            vlan_tag: group.vlan_tag,
            subnet_cidr: group.subnet_cidr,
        })),
        trunk_vlan_ids: desiredTrunks,
        docker_bridge_cidrs: observation.guest.docker_bridge_cidrs,
    });
    const persistentTopologyMatches = observation.net1.name === "eth1"
        && observation.net1.bridge === accessPlan.desired_state.transport.bridge;
    // Two questions, deliberately separated. "Carried" decides the check status,
    // and therefore whether the Access policy apply is allowed to proceed at all.
    // "Exact" decides whether a trunk update is planned, so an extra VLAN is
    // still reported and still pruned -- it just no longer bars the door.
    const persistentTrunksCarried = carriesEveryVlan(observation.net1.trunks, desiredTrunks);
    const liveTrunksCarried = observation.host_veth.exists
        && carriesEveryVlan(observation.host_veth.vlan_ids, desiredTrunks);
    const persistentTrunksExact = sameVlans(observation.net1.trunks, desiredTrunks);
    const liveTrunksExact = observation.host_veth.exists
        && sameVlans(observation.host_veth.vlan_ids, desiredTrunks);
    const guestReport = compareAccessObservation(accessPlan, observation.guest);
    const checks: ReconciliationDryRun["checks"] = [
        {
            key: "access-observer-errors",
            component: "access",
            status: observation.errors.length === 0 ? "pass" : "fail",
            required: true,
            detail: observation.errors.length === 0
                ? "Access observer completed without errors"
                : `${observation.errors.length} Access observer error(s) reported`,
        },
        {
            key: "access-persistent-topology",
            component: "access",
            status: persistentTopologyMatches ? "pass" : "fail",
            required: true,
            detail: persistentTopologyMatches
                ? "LXC 200 net1 uses eth1 on vmbr20"
                : "LXC 200 net1 does not use the approved eth1/vmbr20 topology",
            observed: { name: observation.net1.name, bridge: observation.net1.bridge },
        },
        {
            key: "access-persistent-trunks",
            component: "access",
            status: persistentTrunksCarried ? "pass" : "fail",
            required: true,
            detail: `Requires [${desiredTrunks.join(", ")}], observed [${observation.net1.trunks.join(", ")}]`,
        },
        {
            key: "access-migration-vlan",
            component: "access",
            status: desiredTrunks.includes(2000) && observation.net1.trunks.includes(2000)
                ? "pass"
                : "fail",
            required: true,
            detail: "VLAN 2000 must remain in the persistent Access trunk",
        },
        {
            key: "access-live-veth",
            component: "access",
            status: observation.host_veth.exists ? "pass" : "fail",
            required: true,
            detail: observation.host_veth.exists
                ? `${observation.host_veth.name} exists`
                : `${observation.host_veth.name} is missing`,
        },
        {
            key: "access-live-trunks",
            component: "access",
            status: liveTrunksCarried ? "pass" : "fail",
            required: true,
            detail: `Requires [${desiredTrunks.join(", ")}], observed [${observation.host_veth.vlan_ids.join(", ")}]`,
        },
        ...guestReport.checks.map((check) => ({
            key: `access-guest-${check.key}`,
            component: "access" as const,
            status: check.status,
            required: !check.key.endsWith("-source"),
            detail: check.detail,
        })),
    ];
    const actions: ReconciliationDryRun["actions"] = [];
    if (!persistentTopologyMatches || !persistentTrunksExact) {
        actions.push({
            component: "access",
            operation: "update",
            execution_state: "planned",
            resource: "lxc/200/net1",
            desired: {
                name: "eth1",
                bridge: accessPlan.desired_state.transport.bridge,
                trunks: desiredTrunks,
            },
        });
    }
    if (!liveTrunksExact) {
        actions.push({
            component: "access",
            operation: "update",
            execution_state: "planned",
            resource: `bridge/${observation.host_veth.name}/vlans`,
            desired: { vlan_ids: desiredTrunks },
        });
    }
    if (!guestReport.ready && guestReport.checks.some(
        (check) => check.status === "fail" && !check.key.endsWith("-source"),
    )) {
        actions.push({
            component: "access",
            operation: "update",
            execution_state: "planned",
            resource: "lxc/200/guest-network-policy",
            desired: { revision: accessPlan.revision },
        });
    }
    return { checks, actions };
}