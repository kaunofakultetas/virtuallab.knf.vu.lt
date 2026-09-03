// -----------------------------------------------------------
//  [*] Network — the Access desired-state plan
//
//  Builds the AccessPlan: LXC 200's management surface, its
//  VLAN transport interfaces (one per group, strictly
//  validated against the canonical projection), the trunk
//  allowlist, and the Docker bridges the ruleset must admit.
//  Two entry points: buildAccessPlan filters to `active`
//  groups (readiness/drift views), buildOperationalAccessPlan
//  takes the infrastructure plan's operational set (the
//  apply path).
//
//  Used by:
//    - adapters/access.ts, access-apply.ts,
//      access-observation.ts (the AccessPlan type)
//    - test/access-desired-state.test.ts
// -----------------------------------------------------------

import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { NetworkGroupState } from "@/types/network-groups";
import {
    networkProjectionConfig,
    NetworkProjectionConfig,
    validateNetworkProjectionConfig,
} from "./config";

export type AccessGroupInput = {
    group_id: number;
    state: NetworkGroupState;
    vlan_tag: number | null;
    subnet_cidr: string | null;
};

export type AccessDesiredStateInput = {
    groups: AccessGroupInput[];
    docker_bridge_cidrs: string[];
};

export type OperationalAccessDesiredStateInput = {
    groups: Array<{
        group_id: number;
        vlan_tag: number;
        subnet_cidr: string;
    }>;
    trunk_vlan_ids: number[];
    docker_bridge_cidrs: string[];
};

export type AccessVlanInterface = {
    group_id: number;
    vlan_tag: number;
    interface_name: string;
    subnet_cidr: string;
    address_cidr: string;
};

// Bump whenever rendered Access policy changes meaning.
//
// The revision hashes this document, not the rendered text, so a renderer-only
// change would otherwise produce an identical revision -- and the sole
// convergence signal for Access is whether the live ruleset carries the revision
// comment. A host still running the old output would report a match and pass its
// drift check, exactly the failure GATEWAY_RENDER_VERSION was introduced for on
// the Gateway side. Access has no per-file digest check to catch it either.
//
// 1: zero-group forward chain stated explicitly instead of silently omitting the
//    lab accept rule.
export const ACCESS_RENDER_VERSION = 2;

export type AccessDesiredState = {
    version: 1;
    render_version: number;
    ipv6_enabled: false;
    management: {
        address_cidr: string;
        allowed_sources: string[];
        service_ports: [8080, 9443];
    };
    transport: {
        access_vmid: number;
        bridge: string;
        parent_interface: "eth1";
        trunk_vlan_ids: number[];
        trunk_allowlist: string;
        interfaces: AccessVlanInterface[];
    };
    docker: {
        bridge_cidrs: string[];
    };
};

export type AccessPlan = {
    revision: string;
    desired_state: AccessDesiredState;
};


function parseIpv4Cidr(cidr: string, label: string): { address: string; prefix: number } {
    const [address, prefixText, extra] = cidr.split("/");
    const prefix = Number(prefixText);
    if (extra !== undefined || isIP(address) !== 4 || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
        throw new Error(`${label} must be a valid IPv4 CIDR`);
    }
    return { address, prefix };
}


function canonicalCidrs(cidrs: string[], label: string): string[] {
    return [...new Set(cidrs.map((cidr) => {
        parseIpv4Cidr(cidr, label);
        return cidr;
    }))].sort();
}








// -----------------------------------------------------------
// buildInterface
// -----------------------------------------------------------
//
// One group → its eth1.<vlan> interface. The persisted
// subnet must match the VLAN's canonical 10.200.<index>.0/24
// exactly; the Access address is the fixed accessHost in
// that subnet.
//
// Used by:
//   - buildAccessPlan, buildOperationalAccessPlan (below)
// -----------------------------------------------------------

function buildInterface(
    group: Pick<AccessGroupInput, "group_id" | "vlan_tag" | "subnet_cidr">,
    config: NetworkProjectionConfig,
    groupLabel = "Active group",
): AccessVlanInterface {
    if (group.vlan_tag === null || group.subnet_cidr === null) {
        throw new Error(`${groupLabel} ${group.group_id} has no persisted VLAN/subnet allocation`);
    }
    if (group.vlan_tag < config.vlan.first || group.vlan_tag > config.vlan.last) {
        throw new Error(`${groupLabel} ${group.group_id} VLAN ${group.vlan_tag} is outside the approved pool`);
    }

    const { address, prefix } = parseIpv4Cidr(
        group.subnet_cidr,
        `${groupLabel} ${group.group_id} subnet`,
    );
    const octets = address.split(".").map(Number);
    const expectedSubnetIndex = group.vlan_tag - config.vlan.first;
    if (
        prefix !== config.ipv4.groupPrefix ||
        octets[0] !== 10 ||
        octets[1] !== 200 ||
        octets[2] !== expectedSubnetIndex ||
        octets[3] !== 0
    ) {
        throw new Error(
            `${groupLabel} ${group.group_id} subnet does not match VLAN ${group.vlan_tag}`,
        );
    }

    return {
        group_id: group.group_id,
        vlan_tag: group.vlan_tag,
        interface_name: `eth1.${group.vlan_tag}`,
        subnet_cidr: group.subnet_cidr,
        address_cidr: `${octets[0]}.${octets[1]}.${octets[2]}.${config.ipv4.accessHost}/${prefix}`,
    };
}








// -----------------------------------------------------------
// buildPlan
// -----------------------------------------------------------
//
// The shared assembly: duplicate-allocation checks, trunk
// canonicalisation (the trunk must cover every interface),
// then the hashed desired-state document.
//
// Used by:
//   - buildAccessPlan, buildOperationalAccessPlan (below)
// -----------------------------------------------------------

function buildPlan(
    interfaces: AccessVlanInterface[],
    trunkVlanIds: number[],
    dockerBridgeCidrs: string[],
    duplicateLabel: string,
    config: NetworkProjectionConfig,
): AccessPlan {
    const vlanIds = interfaces.map(({ vlan_tag }) => vlan_tag);
    if (new Set(vlanIds).size !== vlanIds.length) {
        throw new Error(`${duplicateLabel} contain duplicate VLAN allocations`);
    }
    const subnetCidrs = interfaces.map(({ subnet_cidr }) => subnet_cidr);
    if (new Set(subnetCidrs).size !== subnetCidrs.length) {
        throw new Error(`${duplicateLabel} contain duplicate subnet allocations`);
    }

    const canonicalTrunks = [...new Set(trunkVlanIds)].sort((left, right) => left - right);
    for (const vlanId of canonicalTrunks) {
        if (!Number.isInteger(vlanId) || vlanId < config.vlan.first || vlanId > config.vlan.last) {
            throw new Error(`Access trunk VLAN ${vlanId} is outside the approved pool`);
        }
    }
    if (vlanIds.some((vlanId) => !canonicalTrunks.includes(vlanId))) {
        throw new Error("Access trunk allowlist must include every desired VLAN interface");
    }

    const desiredState: AccessDesiredState = {
        version: 1,
        render_version: ACCESS_RENDER_VERSION,
        ipv6_enabled: false,
        management: {
            address_cidr: config.infrastructure.accessManagementCidr,
            allowed_sources: canonicalCidrs(
                config.infrastructure.accessServiceSourceCidrs,
                "Access management source",
            ),
            service_ports: [8080, 9443],
        },
        transport: {
            access_vmid: config.proxmox.accessVmid,
            bridge: config.proxmox.bridge,
            parent_interface: "eth1",
            trunk_vlan_ids: canonicalTrunks,
            trunk_allowlist: canonicalTrunks.join(";"),
            interfaces,
        },
        docker: {
            bridge_cidrs: canonicalCidrs(dockerBridgeCidrs, "Docker bridge"),
        },
    };
    const serialized = JSON.stringify(desiredState);
    return {
        revision: createHash("sha256").update(serialized).digest("hex"),
        desired_state: desiredState,
    };
}








// -----------------------------------------------------------
// buildAccessPlan
// -----------------------------------------------------------
//
// The `active`-groups view: trunk = exactly the active
// VLANs.
//
// Used by:
//   - adapters/access.ts — drift comparison inputs
// -----------------------------------------------------------

export function buildAccessPlan(
    input: AccessDesiredStateInput,
    config: NetworkProjectionConfig = networkProjectionConfig,
): AccessPlan {
    validateNetworkProjectionConfig(config);
    const interfaces = input.groups
        .filter(({ state }) => state === "active")
        .map((group) => buildInterface(group, config))
        .sort((left, right) => left.vlan_tag - right.vlan_tag);
    return buildPlan(
        interfaces,
        interfaces.map(({ vlan_tag }) => vlan_tag),
        input.docker_bridge_cidrs,
        "Active network groups",
        config,
    );
}








// -----------------------------------------------------------
// buildOperationalAccessPlan
// -----------------------------------------------------------
//
// The apply-path view: groups and trunk come from the
// infrastructure plan's operational set, so the trunk may
// be wider than the interfaces (it always carries the
// migration VLAN).
//
// Used by:
//   - access-apply.ts — buildAccessApplyPlan
// -----------------------------------------------------------

export function buildOperationalAccessPlan(
    input: OperationalAccessDesiredStateInput,
    config: NetworkProjectionConfig = networkProjectionConfig,
): AccessPlan {
    validateNetworkProjectionConfig(config);
    const interfaces = input.groups
        .map((group) => buildInterface(group, config, "Operational group"))
        .sort((left, right) => left.vlan_tag - right.vlan_tag);
    return buildPlan(
        interfaces,
        input.trunk_vlan_ids,
        input.docker_bridge_cidrs,
        "Operational network groups",
        config,
    );
}
