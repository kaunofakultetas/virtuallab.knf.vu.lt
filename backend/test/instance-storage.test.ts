import assert from "node:assert/strict";
import test from "node:test";
import {
    assertStorageCapacity,
    getBootDiskStorage,
} from "../src/proxmox/storage";

test("derives the datastore from the template boot disk", () => {
    assert.equal(getBootDiskStorage({
        boot: "order=scsi0;ide2;net0",
        scsi0: "local-lvm:base-9000-disk-0,size=32G",
    }), "local-lvm");
});

test("rejects inactive, full, and low-capacity storage", () => {
    assert.throws(
        () => assertStorageCapacity(
            "local-lvm",
            { active: 0, enabled: 1, avail: 10_000_000_000 },
            2_147_483_648,
        ),
        /not active and enabled/,
    );
    assert.throws(
        () => assertStorageCapacity(
            "local-lvm",
            { active: 1, enabled: 1, avail: 0 },
            2_147_483_648,
        ),
        /0\.00 GiB available/,
    );
    assert.throws(
        () => assertStorageCapacity(
            "local-lvm",
            { active: 1, enabled: 1, avail: 1024 ** 3 },
            2_147_483_648,
        ),
        /2\.00 GiB is required/,
    );
});

test("accepts active storage at the configured reserve", () => {
    assert.doesNotThrow(() => assertStorageCapacity(
        "local-lvm",
        { active: 1, enabled: 1, avail: 2_147_483_648 },
        2_147_483_648,
    ));
});