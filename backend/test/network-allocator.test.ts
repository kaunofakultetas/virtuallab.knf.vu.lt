import assert from "node:assert/strict";
import test from "node:test";
import { getNetworkSlot } from "../src/network/config";
import {
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