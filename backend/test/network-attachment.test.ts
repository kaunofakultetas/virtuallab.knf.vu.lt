// -----------------------------------------------------------
//  [*] Tests — network attachment resolution
//
//  Which bridge a VM gets per network mode, and the
//  compensation split between planned and allocated groups.
//
//  Covers src/network/attachment.ts. Run with `npm test`
//  (the whole suite) inside the backend container.
// -----------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import {
    compensateNetworkAttachment,
    NetworkAttachmentError,
    resolveNetworkAttachment,
} from "../src/network/attachment";
import { NetworkGroup, NetworkGroupState } from "../src/types/network-groups";

function buildGroup(overrides: Partial<NetworkGroup> = {}): NetworkGroup {
    return {
        id: 7,
        owner_id: "vu1234",
        profile_id: 3,
        vlan_tag: null,
        vnet_name: null,
        subnet_cidr: null,
        state: "planned",
        desired_revision: null,
        applied_revision: null,
        last_error: null,
        created_at: new Date(0),
        updated_at: new Date(0),
        ...overrides,
    };
}

function allocatedGroup(state: NetworkGroupState = "creating"): NetworkGroup {
    return buildGroup({
        vlan_tag: 2000,
        vnet_name: "lab2000",
        subnet_cidr: "10.200.0.0/24",
        state,
    });
}

for (const mode of ["legacy", "dry-run"] as const) {
    test(`${mode} attaches to the legacy bridge without allocating`, async () => {
        let allocateCalls = 0;
        const group = buildGroup();

        const attachment = await resolveNetworkAttachment(mode, group, {
            allocate: async () => {
                allocateCalls += 1;
                return allocatedGroup();
            },
        });

        assert.equal(attachment.bridge, "vmbr20");
        assert.equal(attachment.isolated, false);
        assert.equal(attachment.group.state, "planned");
        assert.equal(attachment.group.vlan_tag, null);
        assert.equal(allocateCalls, 0);
    });
}

test("active attaches to the allocated VNet", async () => {
    const requested: number[] = [];

    const attachment = await resolveNetworkAttachment("active", buildGroup(), {
        allocate: async (groupId) => {
            requested.push(groupId);
            return allocatedGroup();
        },
    });

    assert.deepEqual(requested, [7]);
    assert.equal(attachment.bridge, "lab2000");
    assert.equal(attachment.isolated, true);
    assert.equal(attachment.group.vlan_tag, 2000);
});

test("active reuses an already active group allocation", async () => {
    const attachment = await resolveNetworkAttachment("active", buildGroup(), {
        allocate: async () => allocatedGroup("active"),
    });

    assert.equal(attachment.bridge, "lab2000");
    assert.equal(attachment.isolated, true);
});

test("active rejects an allocation without a VNet name", async () => {
    await assert.rejects(
        resolveNetworkAttachment("active", buildGroup(), {
            allocate: async () => buildGroup({ state: "creating" }),
        }),
        NetworkAttachmentError,
    );
});

test("active refuses a group left in a non-attachable state", async () => {
    await assert.rejects(
        resolveNetworkAttachment("active", buildGroup(), {
            allocate: async () => allocatedGroup("error"),
        }),
        /is error and cannot accept a VM/,
    );
});

test("compensation removes an unused planned group", async () => {
    const released: number[] = [];
    const recorded: number[] = [];

    await compensateNetworkAttachment(
        { bridge: "vmbr20", group: buildGroup(), isolated: false },
        "clone failed",
        {
            releasePlanned: async (groupId) => {
                released.push(groupId);
            },
            recordError: async (groupId) => {
                recorded.push(groupId);
            },
        },
    );

    assert.deepEqual(released, [7]);
    assert.deepEqual(recorded, []);
});

test("compensation retains an allocated group and records the error", async () => {
    const released: number[] = [];
    const recorded: Array<[number, string]> = [];

    await compensateNetworkAttachment(
        { bridge: "lab2000", group: allocatedGroup(), isolated: true },
        "clone failed",
        {
            releasePlanned: async (groupId) => {
                released.push(groupId);
            },
            recordError: async (groupId, lastError) => {
                recorded.push([groupId, lastError]);
            },
        },
    );

    // The VLAN and subnet must stay reserved until a verified teardown, so the
    // planned-group delete path must never run for an allocated group.
    assert.deepEqual(released, []);
    assert.deepEqual(recorded, [[7, "clone failed"]]);
});
