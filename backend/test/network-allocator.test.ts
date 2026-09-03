// -----------------------------------------------------------
//  [*] Tests — VLAN allocation and group transitions
//
//  findLowestAvailableVlan, the allocation transaction, and
//  the guarded state-machine moves in groups.ts.
//
//  Covers src/network/groups.ts. Run with `npm test` (the
//  whole suite) inside the backend container.
// -----------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import { getNetworkSlot } from "../src/network/config";
import {
    allocateNetworkGroup,
    findLowestAvailableVlan,
    NetworkAllocationError,
} from "../src/network/groups";

test("maps an approved VLAN to its canonical resources", () => {
    assert.deepEqual(getNetworkSlot(2007), {
        vlanTag: 2007,
        vnetName: "lab2007",
        subnetCidr: "10.200.7.0/24",
        gatewayIp: "10.200.7.1",
        accessIp: "10.200.7.2",
        dhcpFirstIp: "10.200.7.25",
        dhcpLastIp: "10.200.7.254",
    });
});

test("rejects VLANs outside the approved pool", () => {
    assert.throws(() => getNetworkSlot(1999), /outside the approved pool 2000-2255/);
    assert.throws(() => getNetworkSlot(2256), /outside the approved pool 2000-2255/);
    assert.throws(() => getNetworkSlot(2000.5), /outside the approved pool 2000-2255/);
});

test("selects the lowest free VLAN", () => {
    assert.equal(findLowestAvailableVlan([2000, 2002, 2003]), 2001);
});

test("rejects an exhausted allocation pool", () => {
    assert.throws(
        () => findLowestAvailableVlan([2000, 2001], 2000, 2001),
        NetworkAllocationError,
    );
});
type Row = Record<string, unknown>;

/**
 * Replays a scripted `network_groups` row through the allocation transaction and
 * records the statements it issues, so the advisory lock, the `FOR UPDATE` read
 * and the state transition can be asserted without a live PostgreSQL.
 */
function allocationDatabase(group: Row, occupied: number[] = []) {
    const statements: string[] = [];
    let current = { ...group };
    return {
        statements,
        current: () => current,
        pool: {
            async connect() {
                return {
                    async query(sql: string, values?: unknown[]) {
                        statements.push(sql.trim().split("\n")[0].trim());
                        if (sql.includes("FROM network_groups WHERE id")) {
                            return { rows: [current] } as never;
                        }
                        if (sql.includes("SELECT vlan_tag")) {
                            return { rows: occupied.map((vlan_tag) => ({ vlan_tag })) } as never;
                        }
                        if (sql.startsWith("UPDATE network_groups")) {
                            // Mirrors what the statement sets, so the returned row
                            // is the row the caller would really receive.
                            if (sql.includes("state = 'creating'") && sql.includes("last_error = NULL")
                                && !sql.includes("vlan_tag = $2")) {
                                current = { ...current, state: "creating", last_error: null };
                            }
                            if (sql.includes("vlan_tag = $2")) {
                                current = {
                                    ...current,
                                    vlan_tag: values?.[1],
                                    vnet_name: values?.[2],
                                    subnet_cidr: values?.[3],
                                    state: "creating",
                                };
                            }
                            if (sql.includes("desired_revision = $2")) {
                                current = { ...current, desired_revision: values?.[1] };
                            }
                            return { rows: [current] } as never;
                        }
                        return { rows: [] } as never;
                    },
                    release() {},
                };
            },
        },
    };
}

const allocated = {
    id: 3,
    owner_id: "vu1234",
    profile_id: 1,
    vlan_tag: 2000,
    vnet_name: "lab2000",
    subnet_cidr: "10.200.0.0/24",
};

test("an errored group with a canonical allocation is resumed rather than stranded", async () => {
    // A failed provisioning attempt keeps its allocation on purpose, but the
    // caller refuses any state other than creating or active. Leaving it
    // `error` would make the student's only group permanently unusable.
    const database = allocationDatabase({ ...allocated, state: "error", last_error: "boom" });
    const group = await allocateNetworkGroup(3, database.pool);
    assert.equal(group.state, "creating");
    assert.equal(group.last_error, null);
    assert.equal(group.vlan_tag, 2000, "the allocation itself must not move");
    assert.ok(database.statements.some((sql) => sql.includes("pg_advisory_xact_lock")));
    assert.ok(database.statements.includes("COMMIT"));
});

test("an active group is returned untouched", async () => {
    const database = allocationDatabase({ ...allocated, state: "active", last_error: null });
    const group = await allocateNetworkGroup(3, database.pool);
    assert.equal(group.state, "active");
    assert.ok(!database.statements.some((sql) => sql.startsWith("UPDATE network_groups")));
});

test("a planned group holding an allocation is refused, not silently resumed", async () => {
    // Allocation and promotion happen in one transaction, so this combination
    // means something wrote the resources outside the allocator.
    const database = allocationDatabase({ ...allocated, state: "planned", last_error: null });
    await assert.rejects(() => allocateNetworkGroup(3, database.pool), NetworkAllocationError);
    assert.ok(database.statements.includes("ROLLBACK"));
});

test("a partial allocation is refused rather than completed by guesswork", async () => {
    const database = allocationDatabase({
        ...allocated, vnet_name: null, state: "error", last_error: null,
    });
    await assert.rejects(
        () => allocateNetworkGroup(3, database.pool),
        /partial allocation/,
    );
});

test("a non-canonical allocation is refused", async () => {
    // The VLAN is the only input; every other field is derived from it, so a
    // mismatch means the row disagrees with the projection that owns it.
    const database = allocationDatabase({
        ...allocated, subnet_cidr: "10.200.9.0/24", state: "error", last_error: null,
    });
    await assert.rejects(
        () => allocateNetworkGroup(3, database.pool),
        /non-canonical allocation/,
    );
});
