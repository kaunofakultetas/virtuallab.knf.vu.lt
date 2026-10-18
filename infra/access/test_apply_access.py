#!/usr/bin/env python3
############################################################
#  [*] Access applier — waiting out the networkd reload
#
#  wait_for_vlan_addresses must hold staging until every
#  staged VLAN interface carries its address again, so the
#  backend's post-stage observation never sees the empty
#  window after `networkctl reload`. `ip` is faked; nothing
#  here touches a network. Run with
#  `python3 -m unittest test_apply_access` from this directory.
############################################################


import json
import subprocess
import unittest
from unittest import mock

import apply_access


FILES = {
    "/etc/systemd/network/50-eth1.2014.network":
        "[Match]\nName=eth1.2014\n\n[Network]\nAddress=10.200.14.2/24\n",
    "/etc/systemd/network/50-eth1.2014.netdev":
        "[NetDev]\nName=eth1.2014\nKind=vlan\n",
    "/etc/systemd/network/50-virtual-lab-eth1.network":
        "[Match]\nName=eth1\n\n[Network]\nVLAN=eth1.2014\n",
}


def ip_output(*addresses: tuple[str, str, int]) -> subprocess.CompletedProcess:
    links = [
        {"ifname": name, "addr_info": [{"local": local, "prefixlen": prefix}]}
        for name, local, prefix in addresses
    ]
    return subprocess.CompletedProcess([], 0, json.dumps(links), "")


class WaitForVlanAddressesTest(unittest.TestCase):

    # The first poll lands inside the reload window (no address yet); the wait
    # must keep polling until the address is back rather than return early.
    def test_waits_until_address_returns(self) -> None:
        responses = [ip_output(), ip_output(("eth1.2014", "10.200.14.2", 24))]
        with mock.patch.object(apply_access, "run", side_effect=responses) as run, \
                mock.patch.object(apply_access.time, "sleep"):
            self.assertTrue(apply_access.wait_for_vlan_addresses(FILES))
        self.assertEqual(run.call_count, 2)

    def test_gives_up_after_timeout(self) -> None:
        with mock.patch.object(apply_access, "run", return_value=ip_output()), \
                mock.patch.object(apply_access.time, "sleep"):
            self.assertFalse(apply_access.wait_for_vlan_addresses(FILES, timeout=0))


if __name__ == "__main__":
    unittest.main()
