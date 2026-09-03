// -----------------------------------------------------------
//  [*] Tests — instance address selection
//
//  Subnet-membership selection, the legacy-prefix fallback,
//  and every unverifiable input refused rather than guessed.
//
//  Covers src/network/address-selection.ts. Run with `npm
//  test` (the whole suite) inside the backend container.
// -----------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import {
    AddressSelectionError,
    selectInstanceAddress,
} from "../src/network/address-selection";

const legacy = { subnetCidr: null, legacyPrefix: "10.10." };

test("selects the address inside the allocated subnet", () => {
    const selected = selectInstanceAddress(
        ["10.10.10.7", "10.200.5.42", "172.17.0.1"],
        { subnetCidr: "10.200.5.0/24", legacyPrefix: "10.10." },
    );

    assert.equal(selected, "10.200.5.42");
});

test("never mistakes 10.10.100.5 for a member of 10.10.10.0/24", () => {
    // String-prefix matching would accept this; mask arithmetic must not. The
    // legacy prefix here deliberately matches nothing, so the assertion isolates
    // containment rather than the fallback below it.
    assert.equal(
        selectInstanceAddress(["10.10.100.5"], {
            subnetCidr: "10.10.10.0/24",
            legacyPrefix: "192.168.",
        }),
        null,
    );
});

test("falls back to the legacy prefix rather than stranding a legacy-attached VM", () => {
    // Deliberately the opposite of a stricter earlier rule. A group is reused for
    // every VM its owner launches on a profile, so a VM provisioned on the legacy
    // bridge keeps pointing at a group that may be allocated a subnet later;
    // refusing to fall back left that VM unreachable on every poll, forever.
    // This cannot select another machine: the candidates come from this VM's own
    // guest agent.
    assert.equal(
        selectInstanceAddress(["10.10.20.7"], {
            subnetCidr: "10.200.3.0/24",
            legacyPrefix: "10.10.",
        }),
        "10.10.20.7",
    );
});

test("honours the mask on non-/24 subnets", () => {
    const selection = { subnetCidr: "10.200.5.128/25", legacyPrefix: "10.10." };

    assert.equal(selectInstanceAddress(["10.200.5.100"], selection), null);
    assert.equal(selectInstanceAddress(["10.200.5.200"], selection), "10.200.5.200");
    assert.equal(
        selectInstanceAddress(["10.200.255.7"], { ...selection, subnetCidr: "10.200.0.0/16" }),
        "10.200.255.7",
    );
    assert.equal(
        selectInstanceAddress(["10.200.5.43"], { ...selection, subnetCidr: "10.200.5.42/32" }),
        null,
    );
    assert.equal(
        selectInstanceAddress(["10.200.5.42"], { ...selection, subnetCidr: "10.200.5.42/32" }),
        "10.200.5.42",
    );
});

test("accepts a subnet written with host bits set", () => {
    const selected = selectInstanceAddress(
        ["10.200.5.42"],
        { subnetCidr: "10.200.5.1/24", legacyPrefix: "10.10." },
    );

    assert.equal(selected, "10.200.5.42");
});

test("ignores loopback, link-local and unconfigured addresses", () => {
    const selected = selectInstanceAddress(
        ["127.0.0.1", "127.0.1.1", "0.0.0.0", "169.254.10.2", "10.200.5.42"],
        { subnetCidr: "10.200.5.0/24", legacyPrefix: "10.10." },
    );

    assert.equal(selected, "10.200.5.42");
    assert.equal(
        selectInstanceAddress(["127.0.0.1", "169.254.10.2"], legacy),
        null,
    );
});

test("ignores addresses that are not IPv4", () => {
    const selected = selectInstanceAddress(
        ["fe80::1", "", "not-an-address", "10.200.5.42"],
        { subnetCidr: "10.200.5.0/24", legacyPrefix: "10.10." },
    );

    assert.equal(selected, "10.200.5.42");
});

test("is deterministic when several addresses match the subnet", () => {
    const selection = { subnetCidr: "10.200.5.0/24", legacyPrefix: "10.10." };
    const addresses = ["10.200.5.42", "10.200.5.9", "10.200.5.100"];

    assert.equal(selectInstanceAddress(addresses, selection), "10.200.5.9");
    assert.equal(selectInstanceAddress([...addresses].reverse(), selection), "10.200.5.9");
});

test("falls back to the configured prefix when no subnet is allocated", () => {
    assert.equal(
        selectInstanceAddress(["172.17.0.1", "10.10.10.55", "10.10.10.5"], legacy),
        "10.10.10.55",
    );
    assert.equal(
        selectInstanceAddress(["10.20.0.9"], { subnetCidr: null, legacyPrefix: "10.20." }),
        "10.20.0.9",
    );
    assert.equal(selectInstanceAddress(["192.168.1.20"], legacy), null);
    assert.equal(selectInstanceAddress([], legacy), null);
});

test("refuses a malformed subnet instead of selecting an address", () => {
    for (const subnetCidr of [
        "",
        "10.200.5.0",
        "10.200.5.0/",
        "10.200.5.0/33",
        "10.200.5.0/24/8",
        "not-an-address/24",
        "fd00::/64",
    ]) {
        assert.throws(
            () => selectInstanceAddress(["10.200.5.42"], { subnetCidr, legacyPrefix: "10.10." }),
            AddressSelectionError,
            `expected ${subnetCidr} to be rejected`,
        );
    }
});

test("refuses legacy selection without a configured prefix", () => {
    assert.throws(
        () => selectInstanceAddress(["10.10.10.5"], { subnetCidr: null, legacyPrefix: "" }),
        AddressSelectionError,
    );
});

test("rejects a /0 subnet instead of matching every address", () => {
    // Same hazard as the trailing-slash case, spelled explicitly: /0 would make
    // containment unconditionally true and select an arbitrary address.
    assert.throws(
        () => selectInstanceAddress(["172.17.0.1"], {
            subnetCidr: "0.0.0.0/0",
            legacyPrefix: "10.10.",
        }),
        AddressSelectionError,
    );
});

test("falls back to the legacy prefix when no address is on the allocated subnet", () => {
    // A group is reused across a user's VMs, so a legacy-attached VM can end up
    // pointing at a group that was allocated a subnet later. Returning null there
    // would make that VM permanently unreachable.
    const selected = selectInstanceAddress(["10.10.20.42"], {
        subnetCidr: "10.200.5.0/24",
        legacyPrefix: "10.10.",
    });
    assert.equal(selected, "10.10.20.42");
});

test("still prefers the allocated subnet over a legacy-prefixed address", () => {
    const selected = selectInstanceAddress(["10.10.20.42", "10.200.5.31"], {
        subnetCidr: "10.200.5.0/24",
        legacyPrefix: "10.10.",
    });
    assert.equal(selected, "10.200.5.31");
});

test("filters unroutable addresses on the legacy path too", () => {
    // The previous fixture used a prefix that excluded these anyway, so removing
    // the unroutable filter would not have failed it.
    assert.equal(
        selectInstanceAddress(["127.0.0.1", "127.0.0.53"], {
            subnetCidr: null,
            legacyPrefix: "127.",
        }),
        null,
    );
    assert.equal(
        selectInstanceAddress(["169.254.10.2"], { subnetCidr: null, legacyPrefix: "169.254." }),
        null,
    );
});
