#!/usr/bin/env python3

import json
import unittest

import observe_access_forced_command as observer


class ForcedCommandTest(unittest.TestCase):
    def test_accepts_only_the_fixed_observe_request(self) -> None:
        request = observer.parse_request(json.dumps({
            "version": 1,
            "request_id": "00000000-0000-4000-8000-000000000001",
            "target": "access",
            "operation": "observe",
        }).encode())
        self.assertEqual(request["target"], "access")
        with self.assertRaisesRegex(ValueError, "unknown or missing"):
            observer.parse_request(json.dumps({**request, "apply": True}).encode())

    def test_parses_owned_net1_fields_without_rebuilding_the_nic(self) -> None:
        self.assertEqual(observer.parse_net1(
            "name=eth1,bridge=vmbr20,hwaddr=AA:BB:CC:DD:EE:FF,ip=10.10.20.10/24,trunks=2002;2000,type=veth",
        ), {
            "name": "eth1",
            "bridge": "vmbr20",
            "ip": "10.10.20.10/24",
            "trunks": [2000, 2002],
        })
        with self.assertRaisesRegex(ValueError, "duplicate"):
            observer.parse_net1("name=eth1,name=eth2,bridge=vmbr20")

    def test_parses_structured_live_bridge_vlans(self) -> None:
        self.assertEqual(observer.parse_bridge_vlans(json.dumps([{
            "ifname": "veth200i1",
            "vlans": [
                {"vlan": 2002},
                {"vlan": 1, "flags": ["PVID", "Egress Untagged"]},
                {"vlan": 2000},
            ],
        }])), [2000, 2002])


if __name__ == "__main__":
    unittest.main()