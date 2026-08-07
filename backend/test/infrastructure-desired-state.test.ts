import assert from "node:assert/strict";
import test from "node:test";
import {
    buildInfrastructurePlan,
    InfrastructureDesiredStateInputRow,
} from "../src/network/infrastructure-desired-state";

function group(
    id: number,
    state: InfrastructureDesiredStateInputRow["state"],
    vlan: number | null,
): InfrastructureDesiredStateInputRow {
    const subnetIndex = vlan === null ? null : vlan - 2000;
    return {
        id,
        owner_id: `student-${id}`,
        profile_id: 1,
        profile_name: "Default",
        domains: [],
        state,
        vlan_tag: vlan,
        vnet_name: vlan === null ? null : `lab${vlan}`,
        subnet_cidr: subnetIndex === null ? null : `10.200.${subnetIndex}.0/24`,
    };
}

test("projects only persisted operational groups", () => {
    const plan = buildInfrastructurePlan([
        group(1, "planned", null),
        group(2, "creating", 2002),
        group(3, "active", 2003),
        group(4, "error", 2004),
        group(5, "error", null),
        group(6, "deleting", 2006),
    ]);

    assert.deepEqual(
        plan.desired_state.groups.map(({ group_id }) => group_id),
        [2, 3, 4],
    );
    assert.deepEqual(plan.desired_state.proxmox.vnets, [
        { vnet: "lab2002", zone: "labzone", tag: 2002 },
        { vnet: "lab2003", zone: "labzone", tag: 2003 },
        { vnet: "lab2004", zone: "labzone", tag: 2004 },
    ]);
});

test("preserves Access VLAN 2000 without adding it to Gateway", () => {
    const empty = buildInfrastructurePlan([]);
    const allocated = buildInfrastructurePlan([
        group(1, "active", 2000),
        group(2, "creating", 2002),
    ]);

    assert.deepEqual(empty.desired_state.trunks.access_vlan_ids, [2000]);
    assert.deepEqual(empty.desired_state.trunks.gateway_vlan_ids, []);
    assert.deepEqual(allocated.desired_state.trunks.access_vlan_ids, [2000, 2002]);
    assert.deepEqual(allocated.desired_state.trunks.gateway_vlan_ids, [2000, 2002]);
});

test("is deterministic and rejects malformed operational allocations", () => {
    const rows = [group(2, "active", 2002), group(1, "creating", 2001)];
    assert.equal(
        buildInfrastructurePlan(rows).revision,
        buildInfrastructurePlan([...rows].reverse()).revision,
    );
    assert.throws(
        () => buildInfrastructurePlan([{
            ...group(1, "creating", 2001),
            subnet_cidr: null,
        }]),
        /partial persisted allocation/,
    );
    assert.throws(
        () => buildInfrastructurePlan([group(1, "creating", null)]),
        /has no persisted allocation/,
    );
});