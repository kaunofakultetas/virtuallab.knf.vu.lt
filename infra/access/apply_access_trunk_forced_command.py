#!/usr/bin/env python3
############################################################
#  [*] Access trunk — forced command on the Proxmox host
#
#  Reconciles Access LXC 200's VLAN trunk. Unlike the Access
#  policy applier, both halves of this live on the Proxmox
#  HOST, not in the guest:
#
#    persistent  `pct set 200 --net1 ...,trunks=<list>`
#                survives restart, does not reprogram a
#                running veth
#    live        `bridge vlan add/del dev veth200i1`
#                takes effect now, lost on restart
#
#  That is why they are tracked and applied separately, and
#  why the persistent half is written FIRST: `pct set` can
#  trigger NIC reconfiguration, which would wipe freshly
#  programmed bridge VLANs if the order were reversed.
#
#  Operations (JSON on stdin, JSON on stdout):
#    observe  — read both halves, no changes
#    apply    — reconcile to a desired VLAN list, arm timer
#    commit   — cancel the timer once proven converged
#    rollback — restore both halves now
#
#  Used by:
#    - backend access-clients.ts createAccessTrunkApplier —
#      the SSH principal the trunk runner dials
############################################################


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








############################################################
# TrunkError
############################################################
#
# A failure to report to the caller as a clean stderr line
# and exit code — not a crash with a traceback.
############################################################

class TrunkError(Exception):
    pass








############################################################
# run
############################################################
#
# The shared subprocess wrapper: captured output, text mode,
# a 30 s default timeout, check=True unless the caller opts
# out.
#
# Used by:
#   - nearly every function in this file
############################################################

def run(command: list[str], *, check: bool = True, timeout: int = 30) -> subprocess.CompletedProcess:
    return subprocess.run(command, check=check, capture_output=True, text=True, timeout=timeout)








############################################################
# parse_request
############################################################
#
# Reads and validates the JSON request from stdin: bounded
# size, version/target/operation checks, and a strict UUID
# request ID.
#
# Used by:
#   - main (below)
############################################################

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








############################################################
# current_net1
############################################################
#
# The raw net1 property string from the LXC config. Its
# absence is an error: without net1 there is no trunk to
# reconcile.
#
# Used by:
#   - observe (below)
############################################################

def current_net1() -> str:
    for line in run(["pct", "config", str(VMID)]).stdout.splitlines():
        if line.startswith("net1: "):
            return line[len("net1: "):]
    raise TrunkError("LXC net1 is missing")








############################################################
# parse_trunks
############################################################
#
# The sorted VLAN list out of a net1 string's trunks= field;
# empty when the field is absent.
#
# Used by:
#   - observe (below)
############################################################

def parse_trunks(net1: str) -> list[int]:
    for field in net1.split(","):
        key, separator, value = field.partition("=")
        if key == "trunks" and separator:
            return sorted(int(item) for item in value.split(";") if item)
    return []








############################################################
# with_trunks
############################################################
#
# Rewrites only the trunks= field, preserving every other
# property. Rebuilding the whole string from assumed fields
# would silently drop hwaddr or host-managed, so the MAC
# would change on a trunk edit.
#
# Used by:
#   - operation_apply (below)
############################################################

def with_trunks(net1: str, vlan_ids: list[int]) -> str:
    rendered = ";".join(str(vlan) for vlan in vlan_ids)
    fields = [field for field in net1.split(",") if not field.startswith("trunks=")]
    if rendered:
        fields.append(f"trunks={rendered}")
    return ",".join(fields)








############################################################
# live_vlan_ids
############################################################
#
# Tagged VLAN membership of the running host veth. PVID /
# Egress Untagged entries are filtered out: that is VLAN 1
# carrying the untagged path, and it must never appear in a
# plan or a diff.
#
# Used by:
#   - observe (below)
############################################################

def live_vlan_ids() -> list[int]:
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








############################################################
# observe
############################################################
#
# Both halves of the trunk in one snapshot: the persistent
# net1 config and the live bridge membership (empty when the
# veth is down — an absent veth is a fact, not an error,
# for a read).
#
# Used by:
#   - main (below) — operation "observe"
#   - operation_apply (below) — before/after snapshots
#   - operation_commit, operation_rollback (below)
############################################################

def observe() -> dict[str, Any]:
    veth_present = run(["ip", "link", "show", "dev", HOST_VETH], check=False).returncode == 0
    return {
        "net1": current_net1(),
        "persistent_vlan_ids": parse_trunks(current_net1()),
        "live_veth_present": veth_present,
        "live_vlan_ids": live_vlan_ids() if veth_present else [],
    }








############################################################
# timer_active
############################################################
#
# True while the rollback timer is armed — the window in
# which an applied trunk change still awaits its commit.
#
# Used by:
#   - operation_apply (below) — refuses to stack transactions
#   - operation_commit (below) — the rollback_armed field
############################################################

def timer_active() -> bool:
    return run(["systemctl", "is-active", f"{ROLLBACK_UNIT}.timer"], check=False).stdout.strip() == "active"








############################################################
# arm_rollback
############################################################
#
# Schedules the restore on a transient systemd timer: put
# net1 back verbatim, then undo the live diff — delete what
# this apply added, re-add what it removed.
#
# Used by:
#   - operation_apply (below)
############################################################

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








############################################################
# operation_apply
############################################################
#
# Reconciles both halves of the trunk to the desired VLAN
# list under a rollback timer. The optional expected_net1
# guard makes the apply conditional on the config the caller
# planned against — a concurrent edit fails the apply rather
# than being silently overwritten.
#
# Used by:
#   - main (below) — operation "apply"
############################################################

def operation_apply(request: dict[str, Any]) -> dict[str, Any]:
    # STEP 1: validate the desired list — integers only, inside
    # the taggable range, VLAN 1 never included
    # =========================================================
    desired = request.get("desired_vlan_ids")
    if not isinstance(desired, list) or not desired:
        raise TrunkError("desired_vlan_ids must be a non-empty list")
    if any(not isinstance(v, int) or v <= UNTAGGED_VLAN or v > 4094 for v in desired):
        raise TrunkError("desired_vlan_ids contains a VLAN outside the taggable range")
    desired = sorted(set(desired))


    # STEP 2: snapshot the current state and check the caller's
    # preconditions — expected net1, veth present
    # =========================================================
    expected_net1 = request.get("expected_net1")
    before = observe()
    if expected_net1 is not None and expected_net1 != before["net1"]:
        raise TrunkError("net1 does not match the expected value; re-observe before applying")
    if not before["live_veth_present"]:
        raise TrunkError(f"{HOST_VETH} is absent; refusing to reconcile membership blind")


    # STEP 3: refuse to stack transactions, bound the window
    # ======================================================
    existing = read_transaction()
    if existing and timer_active():
        raise TrunkError(f"transaction {existing['transaction_id']} is awaiting commit or rollback")

    rollback_seconds = int(request.get("rollback_seconds", 300))
    if not MIN_ROLLBACK_SECONDS <= rollback_seconds <= MAX_ROLLBACK_SECONDS:
        raise TrunkError("rollback_seconds is out of range")

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    STATE_DIR.chmod(0o700)


    # STEP 4: compute the live diff and arm the timer BEFORE
    # touching anything
    # ======================================================
    add = [vlan for vlan in desired if vlan not in before["live_vlan_ids"]]
    remove = [vlan for vlan in before["live_vlan_ids"] if vlan not in desired]
    arm_rollback(rollback_seconds, before["net1"], before["live_vlan_ids"], desired)


    # STEP 5: write both halves
    # =========================
    # Persistent first: `pct set` may reconfigure the NIC, which would discard
    # freshly programmed bridge VLANs if the live half went first.
    net1_after = with_trunks(before["net1"], desired)
    if net1_after != before["net1"]:
        run(["pct", "set", str(VMID), "--net1", net1_after])
    for vlan in add:
        run(["bridge", "vlan", "add", "dev", HOST_VETH, "vid", str(vlan)])
    for vlan in remove:
        run(["bridge", "vlan", "del", "dev", HOST_VETH, "vid", str(vlan)])


    # STEP 6: re-observe, judge convergence, record the
    # transaction for commit/rollback
    # =================================================
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








############################################################
# read_transaction
############################################################
#
# The staged transaction record, or None when nothing is
# staged.
#
# Used by:
#   - operation_apply (above), operation_commit,
#     operation_rollback (below)
############################################################

def read_transaction() -> dict[str, Any] | None:
    try:
        return json.loads(TRANSACTION_FILE.read_text())
    except FileNotFoundError:
        return None








############################################################
# cancel_rollback
############################################################
#
# Stops the timer and clears any failed unit state so the
# next apply can reuse the unit name.
#
# Used by:
#   - operation_commit, operation_rollback (below)
############################################################

def cancel_rollback() -> None:
    run(["systemctl", "stop", f"{ROLLBACK_UNIT}.timer"], check=False)
    run(["systemctl", "reset-failed", f"{ROLLBACK_UNIT}.timer", f"{ROLLBACK_UNIT}.service"], check=False)








############################################################
# operation_commit
############################################################
#
# Makes an applied trunk change permanent — but only a
# converged one: committing an unconverged change would keep
# the drift and cancel the very timer that would have fixed
# it.
#
# Used by:
#   - main (below) — operation "commit"
############################################################

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








############################################################
# operation_rollback
############################################################
#
# Restores immediately by running the same script the timer
# would have run, then cancels the timer.
#
# Used by:
#   - main (below) — operation "rollback"
############################################################

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








############################################################
# main
############################################################
#
# Root check, request parsing, operation dispatch, and the
# JSON envelope on stdout.
#
# Used by:
#   - the __main__ guard — this is the forced command behind
#     the trunk principal's authorized_keys entry
############################################################

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








# Known failure types become one stderr line and exit 1 — that line is what
# the backend's SSH client reports on a failed trunk call.
if __name__ == "__main__":
    try:
        main()
    except (TrunkError, ValueError, json.JSONDecodeError, OSError, subprocess.SubprocessError) as error:
        detail = str(error)
        if isinstance(error, subprocess.CalledProcessError):
            detail = f"{error.cmd[0]} failed: {(error.stderr or error.stdout or '').strip()}"
        print(f"Access trunk reconciliation failed: {detail[:800]}", file=sys.stderr)
        raise SystemExit(1)
