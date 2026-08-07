import assert from "node:assert/strict";
import test from "node:test";
import { buildAccessPlan } from "../src/network/access-desired-state";
import { renderAccessConfiguration } from "../src/network/access-render";

const plan = buildAccessPlan({
    groups: [
        {
            group_id: 8,
            state: "active",
            vlan_tag: 2001,
            subnet_cidr: "10.200.1.0/24",
        },
        {
            group_id: 7,
            state: "active",
            vlan_tag: 2000,
            subnet_cidr: "10.200.0.0/24",
        },
    ],
    docker_bridge_cidrs: ["172.19.0.0/16", "172.18.0.0/16"],
});

test("renders deterministic networkd VLAN and sysctl configuration", () => {
    const rendered = renderAccessConfiguration(plan);

    const parentDropIn = rendered.files.networkd[
        "/etc/systemd/network/eth1.network.d/50-virtual-lab-vlans.conf"
    ];
    assert.match(parentDropIn, /\[Network\]\nVLAN=eth1\.2000\nVLAN=eth1\.2001/);
    assert.match(
        rendered.files.networkd["/etc/systemd/network/50-eth1.2000.netdev"],
        /\[NetDev\]\nName=eth1\.2000\nKind=vlan\n\n\[VLAN\]\nId=2000/,
    );
    assert.match(
        rendered.files.networkd["/etc/systemd/network/50-eth1.2000.network"],
        /\[Match\]\nName=eth1\.2000\n\n\[Network\]\nAddress=10\.200\.0\.2\/24/,
    );
    assert.deepEqual(Object.keys(rendered.files.networkd), [
        "/etc/systemd/network/eth1.network.d/50-virtual-lab-vlans.conf",
        "/etc/systemd/network/50-eth1.2000.netdev",
        "/etc/systemd/network/50-eth1.2000.network",
        "/etc/systemd/network/50-eth1.2001.netdev",
        "/etc/systemd/network/50-eth1.2001.network",
    ]);
    assert.equal(rendered.files.networkd["/etc/systemd/network/eth1.network"], undefined);
    for (const content of Object.values(rendered.files.networkd)) {
        assert.match(content, new RegExp(`^# Access desired-state revision ${plan.revision}\\.`));
    }
    assert.match(rendered.files.sysctl, /net\.ipv4\.ip_forward = 1/);
    assert.match(rendered.files.sysctl, /net\.ipv6\.conf\.all\.disable_ipv6 = 1/);
});

test("renders pre-DNAT service protection and default-drop forwarding", () => {
    const nftables = renderAccessConfiguration(plan).files.nftables;

    assert.match(nftables, new RegExp(`comment "Access desired-state revision ${plan.revision}"`));
    assert.match(nftables, /hook prerouting priority raw; policy accept;/);
    assert.match(nftables, /ip daddr 10\.10\.10\.50 tcp dport \{ 8080, 9443 \} ip saddr 10\.10\.10\.100\/32 accept/);
    assert.match(nftables, /ip daddr 10\.10\.10\.50 tcp dport \{ 8080, 9443 \} drop/);
    assert.match(nftables, /hook forward priority filter; policy drop;/);
    assert.match(nftables, /ct original ip daddr 10\.10\.10\.50 meta l4proto tcp ct original proto-dst \{ 8080, 9443 \} accept/);
    assert.match(nftables, /ip saddr \{ 172\.18\.0\.0\/16, 172\.19\.0\.0\/16 \} ip daddr \{ 10\.200\.0\.0\/24, 10\.200\.1\.0\/24 \}/);
    assert.doesNotMatch(nftables, /10\.10\.20\.10/);
});

test("renders an empty active VLAN state without an invalid empty nftables set", () => {
    const emptyPlan = buildAccessPlan({ groups: [], docker_bridge_cidrs: [] });
    const rendered = renderAccessConfiguration(emptyPlan);

    assert.deepEqual(rendered.files.networkd, {});
    assert.doesNotMatch(rendered.files.nftables, /ip saddr \{\s*\}/);
    assert.doesNotMatch(rendered.files.nftables, /oifname/);
});

test("rejects active VLAN rendering without observed Docker bridge CIDRs", () => {
    const incompletePlan = buildAccessPlan({
        groups: [{
            group_id: 7,
            state: "active",
            vlan_tag: 2000,
            subnet_cidr: "10.200.0.0/24",
        }],
        docker_bridge_cidrs: [],
    });

    assert.throws(
        () => renderAccessConfiguration(incompletePlan),
        /require at least one observed Docker bridge CIDR/,
    );
});