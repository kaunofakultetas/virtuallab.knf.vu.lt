#!/usr/bin/env python3
############################################################
#  [*] Gateway apply — unit tests for changed_paths
#
#  Exercises the comparison that decides whether dnsmasq
#  and Squid are touched at all; nothing here shells out.
#  Run with `python3 -m unittest test_apply_gateway` from
#  this directory.
############################################################


import tempfile
import unittest
from pathlib import Path

import apply_gateway


OLD = "0" * 64
NEW = "f" * 64


def rendered(revision: str, *lines: str) -> str:
    return "\n".join([f"# Gateway desired-state revision {revision}.", *lines, ""])


class ChangedPathsTest(unittest.TestCase):






    ############################################################
    # test_a_new_revision_alone_is_not_a_change
    ############################################################
    #
    # The revision line moves on every allocation; if it
    # counted, dnsmasq would restart on every VM create again.
    ############################################################

    def test_a_new_revision_alone_is_not_a_change(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            live = Path(directory) / "virtual-lab-gateway.conf"
            live.write_text(rendered(OLD, "bind-dynamic"))
            self.assertEqual(
                apply_gateway.changed_paths({str(live): rendered(NEW, "bind-dynamic")}),
                set(),
            )






    ############################################################
    # test_a_content_change_or_a_missing_file_is_a_change
    ############################################################

    def test_a_content_change_or_a_missing_file_is_a_change(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            live = Path(directory) / "squid.conf"
            live.write_text(rendered(OLD, "http_access deny all"))
            missing = Path(directory) / "absent.conf"
            self.assertEqual(
                apply_gateway.changed_paths({
                    str(live): rendered(NEW, "acl lab2000_src src 10.200.0.0/24", "http_access deny all"),
                    str(missing): rendered(NEW, "bind-dynamic"),
                }),
                {str(live), str(missing)},
            )







    ############################################################
    # test_squid_restarts_only_when_a_remaining_group_loses_access
    ############################################################
    #
    # A new group, or a released one, is reloaded: the released
    # group's VMs are gone. A domain dropped from a group that
    # remains, or any unnamed global line, must restart — a
    # reload would leave the revoked tunnels open.
    ############################################################

    def test_squid_restarts_only_when_a_remaining_group_loses_access(self) -> None:
        both = rendered(
            OLD,
            "acl lab2000_src src 10.200.0.0/24",
            "acl lab2000_dom dstdomain -n .a.example .b.example",
            "acl lab2001_src src 10.200.1.0/24",
            "acl lab2001_dom dstdomain -n .c.example",
            "http_access deny all",
        )
        cases = {
            "grown": (rendered(
                NEW,
                "acl lab2000_src src 10.200.0.0/24",
                "acl lab2000_dom dstdomain -n .a.example .b.example",
                "acl lab2001_src src 10.200.1.0/24",
                "acl lab2001_dom dstdomain -n .c.example",
                "acl lab2002_src src 10.200.2.0/24",
                "http_access deny all",
            ), False),
            "released": (rendered(
                NEW,
                "acl lab2000_src src 10.200.0.0/24",
                "acl lab2000_dom dstdomain -n .a.example .b.example",
                "http_access deny all",
            ), False),
            "revoked": (rendered(
                NEW,
                "acl lab2000_src src 10.200.0.0/24",
                "acl lab2000_dom dstdomain -n .a.example",
                "acl lab2001_src src 10.200.1.0/24",
                "acl lab2001_dom dstdomain -n .c.example",
                "http_access deny all",
            ), True),
            "global": (rendered(
                NEW,
                "acl lab2000_src src 10.200.0.0/24",
                "acl lab2000_dom dstdomain -n .a.example .b.example",
                "acl lab2001_src src 10.200.1.0/24",
                "acl lab2001_dom dstdomain -n .c.example",
            ), True),
        }
        with tempfile.TemporaryDirectory() as directory:
            live = Path(directory) / "squid.conf"
            live.write_text(both)
            for name, (content, expected) in cases.items():
                with self.subTest(name):
                    self.assertIs(apply_gateway.needs_squid_restart(str(live), content), expected)

if __name__ == "__main__":
    unittest.main()
