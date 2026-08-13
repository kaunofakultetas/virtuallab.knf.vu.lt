import assert from "node:assert/strict";
import test from "node:test";
import {
    AccessTrunkInvariantError,
    AccessTrunkPlanInput,
    planAccessTrunk,
} from "../src/network/access-trunk";

function input(overrides: Partial<AccessTrunkPlanInput> = {}): AccessTrunkPlanInput {
    return {
        desired_vlan_ids: [2000, 2001],
        observed: {
            persistent_vlan_ids: [2000, 2001],
            live_veth_present: true,
            live_vlan_ids: [2000, 2001],
        },
        ...overrides,
    };
}

test("reports no change required when both trunk sides already match", () => {
    const plan = planAccessTrunk(input());

    assert.equal(plan.no_change_required, true);
    assert.equal(plan.persistent.status, "satisfied");
    assert.equal(plan.live.status, "satisfied");
    assert.deepEqual(plan.live.add_vlan_ids, []);
    assert.deepEqual(plan.live.remove_vlan_ids, []);
});

test("plans only live additions when the persistent trunk is correct but the veth is stale", () => {
    const plan = planAccessTrunk(input({
        observed: {
            persistent_vlan_ids: [2000, 2001],
            live_veth_present: true,
            live_vlan_ids: [2000],
        },
    }));

    assert.equal(plan.no_change_required, false);
    assert.equal(plan.persistent.status, "satisfied");
    assert.equal(plan.live.status, "drifted");
    assert.deepEqual(plan.live.add_vlan_ids, [2001]);
    assert.deepEqual(plan.live.remove_vlan_ids, []);
});

test("plans only the persistent trunk when live membership is already correct", () => {
    const plan = planAccessTrunk(input({
        observed: {
            persistent_vlan_ids: [2000],
            live_veth_present: true,
            live_vlan_ids: [2000, 2001],
        },
    }));

    assert.equal(plan.no_change_required, false);
    assert.equal(plan.persistent.status, "drifted");
    assert.deepEqual(plan.persistent.set_vlan_ids, [2000, 2001]);
    assert.equal(plan.live.status, "satisfied");
    assert.deepEqual(plan.live.add_vlan_ids, []);
    assert.deepEqual(plan.live.remove_vlan_ids, []);
});

test("sets the complete desired trunk list rather than appending to the observed one", () => {
    const plan = planAccessTrunk(input({
        desired_vlan_ids: [2000, 2002],
        observed: {
            persistent_vlan_ids: [2000, 2001],
            live_veth_present: true,
            live_vlan_ids: [2000, 2001],
        },
    }));

    assert.deepEqual(plan.persistent.set_vlan_ids, [2000, 2002]);
    assert.deepEqual(plan.persistent.observed_vlan_ids, [2000, 2001]);
});

test("removes live VLANs that are no longer desired", () => {
    const plan = planAccessTrunk(input({
        desired_vlan_ids: [2000],
        observed: {
            persistent_vlan_ids: [2000],
            live_veth_present: true,
            live_vlan_ids: [2000, 2001, 2002],
        },
    }));

    assert.equal(plan.live.status, "drifted");
    assert.deepEqual(plan.live.add_vlan_ids, []);
    assert.deepEqual(plan.live.remove_vlan_ids, [2001, 2002]);
});

test("never proposes removing a VLAN that is still desired", () => {
    const desired = [2000, 2001, 2005];
    const plan = planAccessTrunk(input({
        desired_vlan_ids: desired,
        observed: {
            persistent_vlan_ids: [2001],
            live_veth_present: true,
            live_vlan_ids: [2001, 2005, 2099],
        },
    }));

    assert.deepEqual(plan.live.remove_vlan_ids, [2099]);
    for (const vlan of desired) {
        assert.equal(plan.live.remove_vlan_ids.includes(vlan), false);
        assert.equal(plan.persistent.set_vlan_ids.includes(vlan), true);
    }
});

test("is idempotent: replanning against the planned outcome requires no change", () => {
    const first = planAccessTrunk(input({
        desired_vlan_ids: [2000, 2002],
        observed: {
            persistent_vlan_ids: [2000, 2001],
            live_veth_present: true,
            live_vlan_ids: [2001],
        },
    }));
    const applied = first.live.observed_vlan_ids
        .filter((vlan) => !first.live.remove_vlan_ids.includes(vlan))
        .concat(first.live.add_vlan_ids);
    const second = planAccessTrunk({
        desired_vlan_ids: [2000, 2002],
        observed: {
            persistent_vlan_ids: first.persistent.set_vlan_ids,
            live_veth_present: true,
            live_vlan_ids: applied,
        },
    });

    assert.equal(first.no_change_required, false);
    assert.equal(second.no_change_required, true);
    assert.deepEqual(planAccessTrunk(input()), planAccessTrunk(input()));
});

test("canonicalises duplicate and unordered VLAN ids instead of reporting drift", () => {
    const plan = planAccessTrunk(input({
        desired_vlan_ids: [2001, 2000, 2001],
        observed: {
            persistent_vlan_ids: [2001, 2000],
            live_veth_present: true,
            live_vlan_ids: [2000, 2001, 2000],
        },
    }));

    assert.equal(plan.no_change_required, true);
    assert.deepEqual(plan.desired_vlan_ids, [2000, 2001]);
    assert.deepEqual(plan.live.observed_vlan_ids, [2000, 2001]);
});

test("treats a missing host veth as unobservable and refuses to report no change", () => {
    const plan = planAccessTrunk(input({
        observed: {
            persistent_vlan_ids: [2000, 2001],
            live_veth_present: false,
            live_vlan_ids: [],
        },
    }));

    assert.equal(plan.no_change_required, false);
    assert.equal(plan.persistent.status, "satisfied");
    assert.equal(plan.live.status, "unobservable");
    assert.deepEqual(plan.live.add_vlan_ids, []);
    assert.deepEqual(plan.live.remove_vlan_ids, []);
});

test("refuses a desired list that omits the preserved migration VLAN", () => {
    // A caller can legitimately produce an empty or partial list (no active
    // groups, a partial read). Planning a teardown from that would sever the
    // Access LXC's tagged transport with no signal.
    assert.throws(
        () => planAccessTrunk({
            desired_vlan_ids: [],
            observed: { persistent_vlan_ids: [2000], live_veth_present: true, live_vlan_ids: [2000] },
        }),
        AccessTrunkInvariantError,
    );
    assert.throws(
        () => planAccessTrunk({
            desired_vlan_ids: [2001],
            observed: { persistent_vlan_ids: [2000, 2001], live_veth_present: true, live_vlan_ids: [2000, 2001] },
        }),
        AccessTrunkInvariantError,
    );
});

test("refuses unfiltered bridge membership rather than planning to delete VLAN 1", () => {
    // Real `bridge -j vlan show` reports VLAN 1 with PVID/Egress Untagged, and it
    // carries the legacy transport. A plan proposing its removal would cut the
    // only provisioning path that currently works, so this must not parse.
    assert.throws(() => planAccessTrunk({
        desired_vlan_ids: [2000],
        observed: { persistent_vlan_ids: [2000], live_veth_present: true, live_vlan_ids: [1, 2000] },
    }));
});

test("the persistent write list does not alias the plan's desired state", () => {
    const plan = planAccessTrunk({
        desired_vlan_ids: [2000, 2001],
        observed: { persistent_vlan_ids: [2000], live_veth_present: true, live_vlan_ids: [2000] },
    });
    plan.persistent.set_vlan_ids.push(9999);
    assert.deepEqual(plan.desired_vlan_ids, [2000, 2001]);
});

test("rejects VLAN ids outside the taggable range and unknown fields", () => {
    assert.throws(() => planAccessTrunk(input({ desired_vlan_ids: [0] })));
    assert.throws(() => planAccessTrunk(input({ desired_vlan_ids: [4095] })));
    assert.throws(() => planAccessTrunk(input({ desired_vlan_ids: [2000.5] })));
    assert.throws(() => planAccessTrunk({
        desired_vlan_ids: [2000],
        observed: {
            persistent_vlan_ids: [2000],
            live_veth_present: true,
            live_vlan_ids: [2000],
            host_veth: "veth200i1",
        },
    }));
    assert.throws(() => planAccessTrunk({ desired_vlan_ids: [2000] }));
});

test("does not mutate the caller's arrays", () => {
    const desired = [2001, 2000];
    const observedLive = [2099];
    planAccessTrunk({
        desired_vlan_ids: desired,
        observed: {
            persistent_vlan_ids: [2000],
            live_veth_present: true,
            live_vlan_ids: observedLive,
        },
    });

    assert.deepEqual(desired, [2001, 2000]);
    assert.deepEqual(observedLive, [2099]);
});
