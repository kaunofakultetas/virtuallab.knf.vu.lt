// -----------------------------------------------------------
//  [*] Tests — datacenter firewall enforcement
//
//  The cluster enable flag and the control-plane node rules
//  graded together.
//
//  Covers src/network/vm-firewall-enforcement.ts. Run with
//  `npm test` (the whole suite) inside the backend
//  container.
// -----------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import { checkVmFirewallEnforcement } from "../src/network/vm-firewall-enforcement";

function client(options: Record<string, unknown>, rules: Record<string, unknown>[] = []) {
    return {
        async getClusterFirewallOptions() { return options as never; },
        async getNodeFirewallRules() { return rules as never; },
    };
}

const controlPlaneRules = [
    { type: "in", action: "ACCEPT", proto: "tcp", dport: "8006", source: "10.10.10.100" },
    { type: "in", action: "ACCEPT", proto: "tcp", dport: "22", source: "10.10.10.100" },
];

test("a disabled datacenter firewall is a required failure, not a warning", async () => {
    // Every .fw file would read as correct and every apply would converge while
    // student VMs reached each other freely. Nothing else reports this.
    const result = await checkVmFirewallEnforcement(client({ enable: 0 }, controlPlaneRules));

    assert.equal(result.status, "fail");
    assert.match(result.detail, /every per-VM rule is inert/);
});

test("an absent enable flag is treated as disabled", async () => {
    assert.equal((await checkVmFirewallEnforcement(client({}, controlPlaneRules))).status, "fail");
});

test("an enabled firewall without control-plane rules is reported before it bites", async () => {
    // Enabling without them is what actually happened in testing: the
    // orchestrator lost the Proxmox API and every restricted SSH channel.
    const result = await checkVmFirewallEnforcement(client({ enable: 1 }, []));

    assert.equal(result.status, "fail");
    assert.match(result.detail, /tcp\/8006/);
    assert.match(result.detail, /tcp\/22/);
});

test("a partially rules stack names only what is missing", async () => {
    const result = await checkVmFirewallEnforcement(client({ enable: 1 }, [controlPlaneRules[0]]));

    assert.equal(result.status, "fail");
    assert.match(result.detail, /tcp\/22/);
    assert.doesNotMatch(result.detail, /tcp\/8006/);
});

test("a disabled rule does not count as an allowance", async () => {
    const result = await checkVmFirewallEnforcement(client({ enable: 1 }, [
        { ...controlPlaneRules[0], enable: 0 },
        controlPlaneRules[1],
    ]));

    assert.equal(result.status, "fail");
    assert.match(result.detail, /tcp\/8006/);
});

test("a multi-port rule satisfies every port it lists", async () => {
    const result = await checkVmFirewallEnforcement(client({ enable: 1 }, [
        { type: "in", action: "ACCEPT", proto: "tcp", dport: "22,8006" },
    ]));

    assert.equal(result.status, "pass");
});

test("a DROP rule on the right port is not an allowance", async () => {
    const result = await checkVmFirewallEnforcement(client({ enable: 1 }, [
        { type: "in", action: "DROP", proto: "tcp", dport: "8006" },
        controlPlaneRules[1],
    ]));

    assert.equal(result.status, "fail");
    assert.match(result.detail, /tcp\/8006/);
});

test("an enforcing stack with both rules passes", async () => {
    const result = await checkVmFirewallEnforcement(client({ enable: 1 }, controlPlaneRules));

    assert.equal(result.status, "pass");
    assert.match(result.detail, /enforcing per-VM policy/);
});

test("an unreadable firewall state fails rather than defaulting to healthy", async () => {
    const result = await checkVmFirewallEnforcement({
        async getClusterFirewallOptions(): Promise<never> { throw new Error("403 forbidden"); },
        async getNodeFirewallRules() { return [] as never; },
    });

    assert.equal(result.status, "fail");
    assert.match(result.detail, /could not be read: 403 forbidden/);
});
