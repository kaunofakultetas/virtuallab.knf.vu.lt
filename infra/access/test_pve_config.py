#!/usr/bin/env python3
############################################################
#  [*] Forced commands — the direct Proxmox config readers
#
#  read_pve_config and lxc_running are copied into several
#  forced commands so each stays one self-contained file.
#  These tests run the same fixtures through every copy, so
#  the copies cannot drift apart — the trunk applier and the
#  Access observer must read net1 identically. Nothing here
#  touches Proxmox. Run with
#  `python3 -m unittest test_pve_config` from this directory.
############################################################


import hashlib
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "gateway"))

import apply_access_forced_command
import apply_access_trunk_forced_command
import observe_access_forced_command
import observe_gateway_forced_command


CONFIG_READERS = [
    observe_access_forced_command,
    apply_access_trunk_forced_command,
    observe_gateway_forced_command,
]
LXC_STATE_READERS = [observe_access_forced_command, apply_access_forced_command]

NET1 = "name=eth1,bridge=vmbr20,hwaddr=BC:24:11:00:00:01,trunks=2000;2001,type=veth"


class PveConfigTest(unittest.TestCase):






    ############################################################
    # test_digest_is_the_sha1_of_the_raw_file
    ############################################################
    #
    # Matches pvesh's `digest` (verified on the prod host).
    ############################################################

    def test_digest_is_the_sha1_of_the_raw_file(self) -> None:
        raw = f"# description\narch: amd64\nnet1: {NET1}\n".encode()
        for module in CONFIG_READERS:
            with self.subTest(module.__name__):
                digest, config = module.read_pve_config(raw)
                self.assertEqual(digest, hashlib.sha1(raw).hexdigest())
                self.assertEqual(config["net1"], NET1)
                self.assertNotIn("# description", config)






    ############################################################
    # test_snapshots_never_leak_and_pending_is_overlaid
    ############################################################
    #
    # A snapshot's or cloud-init section's keys must not be
    # read as current; a pending section overrides, and its
    # `delete:` removes, exactly as pvesh merges them.
    ############################################################

    def test_snapshots_never_leak_and_pending_is_overlaid(self) -> None:
        raw = (
            f"net1: {NET1}\nnet2: name=eth2,bridge=vmbr0\nipconfig0: ip=dhcp\n\n"
            "[PENDING]\nnet1: name=eth1,bridge=vmbr21\ndelete: net2,!ipconfig0\n\n"
            "[snap1]\nnet1: name=eth1,bridge=vmbr99\nnet3: name=eth3,bridge=vmbr99\n\n"
            "[special:cloudinit]\nnet4: virtio=AA,bridge=vmbr99\n"
        ).encode()
        for module in CONFIG_READERS:
            with self.subTest(module.__name__):
                _, config = module.read_pve_config(raw)
                self.assertEqual(config, {"net1": "name=eth1,bridge=vmbr21"})






    ############################################################
    # test_lxc_state
    ############################################################

    def test_lxc_state(self) -> None:
        for module in LXC_STATE_READERS:
            with self.subTest(module.__name__):
                self.assertTrue(module.lxc_running("State:          RUNNING\n"))
                self.assertFalse(module.lxc_running("State:          STOPPED\n"))
                self.assertFalse(module.lxc_running(""))






    ############################################################
    # test_qemu_running_requires_the_matching_pidfile_argument
    ############################################################
    #
    # A recycled PID belonging to something else must not
    # count as the VM running.
    ############################################################

    def test_qemu_running_requires_the_matching_pidfile_argument(self) -> None:
        qemu_running = observe_gateway_forced_command.qemu_running
        with tempfile.TemporaryDirectory() as directory:
            run_dir, proc = Path(directory) / "run", Path(directory) / "proc"
            (proc / "7509").mkdir(parents=True)
            run_dir.mkdir()
            self.assertFalse(qemu_running(202, run_dir, proc))

            (run_dir / "202.pid").write_text("7509\n")
            (proc / "7509" / "cmdline").write_bytes(b"/usr/bin/kvm\0-id\0" b"202\0-pidfile\0/var/run/qemu-server/202.pid\0")
            self.assertTrue(qemu_running(202, run_dir, proc))

            (proc / "7509" / "cmdline").write_bytes(b"/usr/bin/kvm\0-pidfile\0/var/run/qemu-server/203.pid\0")
            self.assertFalse(qemu_running(202, run_dir, proc))


if __name__ == "__main__":
    unittest.main()
