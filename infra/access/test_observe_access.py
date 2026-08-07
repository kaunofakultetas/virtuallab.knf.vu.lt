#!/usr/bin/env python3

import json
import unittest

import observe_access


class ObserveAccessTest(unittest.TestCase):
    def test_parses_interfaces(self) -> None:
        output = json.dumps([
            {
                "ifname": "eth1.2000",
                "addr_info": [{"family": "inet", "local": "10.200.0.2", "prefixlen": 24}],
            },
            {
                "ifname": "eth0",
                "addr_info": [{"family": "inet", "local": "10.10.10.50", "prefixlen": 24}],
            },
        ])

        self.assertEqual(observe_access.parse_interfaces(output), [
            {"name": "eth0", "addresses": ["10.10.10.50/24"]},
            {"name": "eth1.2000", "addresses": ["10.200.0.2/24"]},
        ])

    def test_parses_only_ipv4_bridge_networks(self) -> None:
        output = json.dumps([
            {"Driver": "bridge", "IPAM": {"Config": [{"Subnet": "172.18.0.1/16"}]}},
            {"Driver": "bridge", "IPAM": {"Config": [{"Subnet": "2001:db8::/64"}]}},
            {"Driver": "host", "IPAM": {"Config": [{"Subnet": "10.0.0.0/8"}]}},
        ])

        self.assertEqual(observe_access.parse_docker_bridge_cidrs(output), ["172.18.0.0/16"])

    def test_parses_service_bindings_and_sources(self) -> None:
        output = "\n".join([
            "LISTEN 0 4096 10.10.10.50:8080 0.0.0.0:*",
            "LISTEN 0 4096 10.10.10.50:9443 0.0.0.0:*",
            "ESTAB 0 0 10.10.10.50:9443 10.10.10.100:53122",
            "ESTAB 0 0 10.10.10.50:22 10.10.10.1:44000",
        ])

        listeners, connections = observe_access.parse_socket_state(output)

        self.assertEqual(listeners, [
            {"port": 8080, "local_address": "10.10.10.50"},
            {"port": 9443, "local_address": "10.10.10.50"},
        ])
        self.assertEqual(connections, [
            {"local_port": 9443, "remote_address": "10.10.10.100"},
        ])

    def test_parses_original_pre_dnat_conntrack_tuple(self) -> None:
        output = " ".join([
            "ipv4 2 tcp 6 431999 ESTABLISHED",
            "src=10.10.10.100 dst=10.10.10.50 sport=53122 dport=8080",
            "src=172.17.0.2 dst=10.10.10.100 sport=8080 dport=53122",
            "[ASSURED] mark=0 use=1",
        ])

        self.assertEqual(observe_access.parse_conntrack(output), [
            {"local_port": 8080, "remote_address": "10.10.10.100"},
        ])

    def test_parses_original_source_from_packet_capture(self) -> None:
        output = "\n".join([
            "IP 10.10.10.100.53122 > 10.10.10.50.8080: Flags [P.], length 42",
            "eth0 In IP 10.10.10.1.44000 > 10.10.10.50.22: Flags [.], length 0",
        ])

        self.assertEqual(observe_access.parse_packet_capture(output), [
            {"local_port": 8080, "remote_address": "10.10.10.100"},
        ])


if __name__ == "__main__":
    unittest.main()