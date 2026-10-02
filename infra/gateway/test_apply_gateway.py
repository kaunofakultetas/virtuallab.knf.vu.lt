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
    # test_only_a_dropped_line_forces_a_squid_restart
    ############################################################
    #
    # Added lines (a new group) can be reloaded; a dropped line
    # (a revoked domain) must restart, or its tunnels survive.
    ############################################################

    def test_only_a_dropped_line_forces_a_squid_restart(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            live = Path(directory) / "squid.conf"
            live.write_text(rendered(OLD, "acl lab2000_dom dstdomain -n .a.example", "http_access deny all"))
            grown = rendered(NEW, "acl lab2000_dom dstdomain -n .a.example", "acl lab2001_src src 10.200.1.0/24", "http_access deny all")
            shrunk = rendered(NEW, "http_access deny all")
            self.assertFalse(apply_gateway.removes_lines(str(live), grown))
            self.assertTrue(apply_gateway.removes_lines(str(live), shrunk))


if __name__ == "__main__":
    unittest.main()
