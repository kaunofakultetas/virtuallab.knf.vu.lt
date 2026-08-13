#!/usr/bin/env python3

"""Forced command that reconciles Access LXC 200's VLAN trunk.

Unlike the Access policy applier, both halves of this live on the Proxmox HOST,
not in the guest:

  persistent  `pct set 200 --net1 ...,trunks=<list>`   survives restart, does not
                                                       reprogram a running veth
  live        `bridge vlan add/del dev veth200i1`      takes effect now, lost on
                                                       restart

That is why they are tracked and applied separately, and why the persistent half
is written FIRST: `pct set` can trigger NIC reconfiguration, which would wipe
freshly programmed bridge VLANs if the order were reversed.

Operations: observe, apply, commit, rollback. JSON on stdin, JSON on stdout.
"""

import datetime
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

VMID = 200
HOST_VETH = "veth200i1"
STATE_DIR = Path("/run/virtual-lab-access-trunk")
TRANSACTION_FILE = STATE_DIR / "transaction.json"
ROLLBACK_UNIT = "virtual-lab-access-trunk-rollback"
ROLLBACK_SCRIPT = STATE_DIR / "rollback.sh"
MAX_REQUEST_BYTES = 64 * 1024

# VLAN 1 is the untagged/PVID membership. It is never a lab VLAN and must never
# be added or removed here; the backend planner refuses it too.
UNTAGGED_VLAN = 1
MIN_ROLLBACK_SECONDS = 60
MAX_ROLLBACK_SECONDS = 1800


class TrunkError(Exception):
    """A failure to report to the caller, not a crash."""


def run(command: list[str], *, check: bool = True, timeout: int = 30) -> subprocess.CompletedProcess:
    return subprocess.run(command, check=check, capture_output=True, text=True, timeout=timeout)


def parse_request() -> dict[str, Any]:
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        raise TrunkError("request exceeds the maximum size")
    request = json.loads(raw)
    if request.get("version") != 1 or request.get("target") != "access-trunk":
        raise TrunkError("unsupported request")
    if request.get("operation") not in {"observe", "apply", "commit", "rollback"}:
        raise TrunkError("unsupported operation")
    if not re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
        str(request.get("request_id", "")),
        re.IGNORECASE,
    ):
        raise TrunkError("invalid request ID")
    return request


def current_net1() -> str:
    for line in run(["pct", "config", str(VMID)]).stdout.splitlines():
        if line.startswith("net1: "):
            return line[len("net1: "):]
    raise TrunkError("LXC net1 is missing")


def parse_trunks(net1: str) -> list[int]:
    for field in net1.split(","):
        key, separator, value = field.partition("=")
        if key == "trunks" and separator:
            return sorted(int(item) for item in value.split(";") if item)
    return []


def with_trunks(net1: str, vlan_ids: list[int]) -> str:
    """Rewrites only the trunks= field, preserving every other property.

    Rebuilding the whole string from assumed fields would silently drop
    hwaddr or host-managed, so the MAC would change on a trunk edit.
    """
    rendered = ";".join(str(vlan) for vlan in vlan_ids)
    fields = [field for field in net1.split(",") if not field.startswith("trunks=")]
    if rendered:
        fields.append(f"trunks={rendered}")
    return ",".join(fields)


def live_vlan_ids() -> list[int]:
    """Tagged VLAN membership of the running host veth.

    PVID / Egress Untagged entries are filtered out: that is VLAN 1 carrying the
    untagged path, and it must never appear in a plan or a diff.
    """
    entries = json.loads(run(["bridge", "-j", "vlan", "show", "dev", HOST_VETH]).stdout)
    matching = [entry for entry in entries if entry.get("ifname") == HOST_VETH]
    if len(matching) != 1:
        raise TrunkError("live host veth observation is missing or duplicated")
    return sorted({
        item["vlan"]
        for item in matching[0].get("vlans", [])
        if "PVID" not in item.get("flags", [])
        and "Egress Untagged" not in item.get("flags", [])
    })


def observe() -> dict[str, Any]:
    veth_present = run(["ip", "link", "show", "dev", HOST_VETH], check=False).returncode == 0
    return {
        "net1": current_net1(),
        "persistent_vlan_ids": parse_trunks(current_net1()),
        "live_veth_present": veth_present,
        "live_vlan_ids": live_vlan_ids() if veth_present else [],
    }


def timer_active() -> bool:
    return run(["systemctl", "is-active", f"{ROLLBACK_UNIT}.timer"], check=False).stdout.strip() == "active"


def arm_rollback(seconds: int, net1_before: str, live_before: list[int], live_after: list[int]) -> None:
    lines = ["#!/bin/sh", "# Automatic rollback for an Access trunk change.", "set -e", ""]
    lines.append(f'pct set {VMID} --net1 "{net1_before}"')
    for vlan in sorted(set(live_after) - set(live_before)):
        lines.append(f"bridge vlan del dev {HOST_VETH} vid {vlan} || true")
    for vlan in sorted(set(live_before) - set(live_after)):
        lines.append(f"bridge vlan add dev {HOST_VETH} vid {vlan} || true")
    lines += [f"rm -f {TRANSACTION_FILE}", ""]
    ROLLBACK_SCRIPT.write_text("\n".join(lines))
    ROLLBACK_SCRIPT.chmod(0o700)
    run(["systemd-run", f"--on-active={seconds}", f"--unit={ROLLBACK_UNIT}", "/bin/sh", str(ROLLBACK_SCRIPT)])


def operation_apply(request: dict[str, Any]) -> dict[str, Any]:
    desired = request.get("desired_vlan_ids")
    if not isinstance(desired, list) or not desired:
        raise TrunkError("desired_vlan_ids must be a non-empty list")
    if any(not isinstance(v, int) or v <= UNTAGGED_VLAN or v > 4094 for v in desired):
        raise TrunkError("desired_vlan_ids contains a VLAN outside the taggable range")
    desired = sorted(set(desired))

    expected_net1 = request.get("expected_net1")
    before = observe()
    if expected_net1 is not None and expected_net1 != before["net1"]:
        raise TrunkError("net1 does not match the expected value; re-observe before applying")
    if not before["live_veth_present"]:
        raise TrunkError(f"{HOST_VETH} is absent; refusing to reconcile membership blind")

    existing = read_transaction()
    if existing and timer_active():
        raise TrunkError(f"transaction {existing['transaction_id']} is awaiting commit or rollback")

    rollback_seconds = int(request.get("rollback_seconds", 300))
    if not MIN_ROLLBACK_SECONDS <= rollback_seconds <= MAX_ROLLBACK_SECONDS:
        raise TrunkError("rollback_seconds is out of range")

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    STATE_DIR.chmod(0o700)

    add = [vlan for vlan in desired if vlan not in before["live_vlan_ids"]]
    remove = [vlan for vlan in before["live_vlan_ids"] if vlan not in desired]
    arm_rollback(rollback_seconds, before["net1"], before["live_vlan_ids"], desired)

    # Persistent first: `pct set` may reconfigure the NIC, which would discard
    # freshly programmed bridge VLANs if the live half went first.
    net1_after = with_trunks(before["net1"], desired)
    if net1_after != before["net1"]:
        run(["pct", "set", str(VMID), "--net1", net1_after])
    for vlan in add:
        run(["bridge", "vlan", "add", "dev", HOST_VETH, "vid", str(vlan)])
    for vlan in remove:
        run(["bridge", "vlan", "del", "dev", HOST_VETH, "vid", str(vlan)])

    after = observe()
    converged = after["persistent_vlan_ids"] == desired and after["live_vlan_ids"] == desired
    transaction_id = f"tr-{datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    TRANSACTION_FILE.write_text(json.dumps({
        "transaction_id": transaction_id,
        "desired_vlan_ids": desired,
        "net1_before": before["net1"],
        "live_before": before["live_vlan_ids"],
    }, sort_keys=True))

    return {
        "transaction_id": transaction_id,
        "desired_vlan_ids": desired,
        "persistent_changed": net1_after != before["net1"],
        "added": add,
        "removed": remove,
        "observed": after,
        "converged": converged,
        "rollback_armed": timer_active(),
        "rollback_seconds": rollback_seconds,
    }


def read_transaction() -> dict[str, Any] | None:
    try:
        return json.loads(TRANSACTION_FILE.read_text())
    except FileNotFoundError:
        return None


def cancel_rollback() -> None:
    run(["systemctl", "stop", f"{ROLLBACK_UNIT}.timer"], check=False)
    run(["systemctl", "reset-failed", f"{ROLLBACK_UNIT}.timer", f"{ROLLBACK_UNIT}.service"], check=False)


def operation_commit(request: dict[str, Any]) -> dict[str, Any]:
    transaction = read_transaction()
    if not transaction:
        raise TrunkError("no transaction is staged")
    if request.get("transaction_id") != transaction["transaction_id"]:
        raise TrunkError("transaction ID does not match the staged transaction")
    after = observe()
    desired = transaction["desired_vlan_ids"]
    if after["persistent_vlan_ids"] != desired or after["live_vlan_ids"] != desired:
        raise TrunkError("refusing to commit a trunk that is not converged; let the rollback fire")
    cancel_rollback()
    TRANSACTION_FILE.unlink(missing_ok=True)
    # Reported rather than assumed: a commit that leaves the timer running means
    # the change is undone minutes from now, which the caller must be able to see
    # without opening a second connection to find out.
    return {
        "transaction_id": transaction["transaction_id"],
        "committed": True,
        "rollback_armed": timer_active(),
        "observed": after,
    }


def operation_rollback(request: dict[str, Any]) -> dict[str, Any]:
    transaction = read_transaction()
    if not transaction:
        raise TrunkError("no transaction is staged")
    requested = request.get("transaction_id")
    if requested and requested != transaction["transaction_id"]:
        raise TrunkError("transaction ID does not match the staged transaction")
    run(["/bin/sh", str(ROLLBACK_SCRIPT)])
    cancel_rollback()
    return {"transaction_id": transaction["transaction_id"], "rolled_back": True, "observed": observe()}


def main() -> None:
    if os.geteuid() != 0:
        raise TrunkError("the Access trunk executor must run as root")
    request = parse_request()
    handlers = {
        "observe": lambda _request: observe(),
        "apply": operation_apply,
        "commit": operation_commit,
        "rollback": operation_rollback,
    }
    result = handlers[request["operation"]](request)
    print(json.dumps({
        "version": 1,
        "request_id": request["request_id"],
        "target": "access-trunk",
        "operation": request["operation"],
        "captured_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        **result,
    }, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except (TrunkError, ValueError, json.JSONDecodeError, OSError, subprocess.SubprocessError) as error:
        detail = str(error)
        if isinstance(error, subprocess.CalledProcessError):
            detail = f"{error.cmd[0]} failed: {(error.stderr or error.stdout or '').strip()}"
        print(f"Access trunk reconciliation failed: {detail[:800]}", file=sys.stderr)
        raise SystemExit(1)
