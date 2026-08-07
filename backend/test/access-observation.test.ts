import assert from "node:assert/strict";
import test from "node:test";
import { buildAccessPlan } from "../src/network/access-desired-state";
import { compareAccessObservation } from "../src/network/access-observation";

const plan = buildAccessPlan({
    groups: [{
        group_id: 1,
        state: "active",
        vlan_tag: 2000,
        subnet_cidr: "10.200.0.0/24",
    }],
    docker_bridge_cidrs: ["172.18.0.0/16"],
});

const observation = {
    version: 1,
    captured_at: "2026-08-07T09:00:00Z",
    hostname: "guacamole",
    interfaces: [
        { name: "eth0", addresses: ["10.10.10.50/24"] },
        { name: "eth1", addresses: [] },
        { name: "eth1.2000", addresses: ["10.200.0.2/24"] },
    ],
    docker_bridge_cidrs: ["172.18.0.0/16"],
    listeners: [
        { port: 8080, local_address: "10.10.10.50" },
        { port: 9443, local_address: "10.10.10.50" },
    ],
    connections: [
        { local_port: 8080, remote_address: "10.10.10.100" },
        { local_port: 9443, remote_address: "10.10.10.100" },
    ],
    sysctl: { ipv4_forwarding: true, ipv6_enabled: false },
    nftables: {
        available: true,
        ruleset: `# Access desired-state revision ${plan.revision}\ntable inet access {}`,
    },
    errors: [],
};

test("reports a converged Access observation", () => {
    const report = compareAccessObservation(plan, observation);

    assert.equal(report.ready, true);
    assert.ok(report.checks.every(({ status }) => status === "pass"));
});

test("reports legacy transport, broad bindings, and unknown sources as drift", () => {
    const report = compareAccessObservation(plan, {
        ...observation,
        interfaces: [
            { name: "eth0", addresses: ["10.10.10.50/24"] },
            { name: "eth1", addresses: ["10.10.20.10/24"] },
        ],
        listeners: [
            { port: 8080, local_address: "0.0.0.0" },
            { port: 9443, local_address: "0.0.0.0" },
        ],
        connections: [{ local_port: 9443, remote_address: "10.200.0.25" }],
    });

    assert.equal(report.ready, false);
    assert.equal(report.checks.find(({ key }) => key === "legacy-transport-address")?.status, "fail");
    assert.equal(report.checks.find(({ key }) => key === "vlan-interfaces")?.status, "fail");
    assert.equal(report.checks.find(({ key }) => key === "service-9443-binding")?.status, "fail");
    assert.equal(report.checks.find(({ key }) => key === "service-9443-source")?.status, "fail");
    assert.equal(report.checks.find(({ key }) => key === "service-8080-source")?.status, "unobserved");
});

test("rejects malformed observations", () => {
    assert.throws(
        () => compareAccessObservation(plan, { ...observation, interfaces: "eth0" }),
        /Invalid input/,
    );
});

test("rejects a readable but stale nftables ruleset", () => {
    const report = compareAccessObservation(plan, {
        ...observation,
        nftables: {
            available: true,
            ruleset: "# Access desired-state revision stale\ntable inet access {}",
        },
    });

    assert.equal(report.ready, false);
    assert.equal(report.checks.find(({ key }) => key === "nftables-revision")?.status, "fail");
});