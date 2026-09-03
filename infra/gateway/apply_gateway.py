#!/usr/bin/env python3
############################################################
#  [*] Gateway apply — policy installer inside VM 202
#
#  Applies rendered Gateway policy with a dead-man's switch.
#  This encodes the procedure that was proven by hand:
#  stage, validate offline, arm an automatic rollback,
#  install, reload, verify — and only then let the caller
#  commit. If the caller never commits (the ruleset locked
#  it out, or the orchestrator died mid-apply), the timer
#  restores the previous state on its own.
#
#  VM 202 has no serial console, so an unreachable guest
#  means offline disk surgery. The timer is therefore armed
#  BEFORE anything is installed, and the caller is expected
#  to prove reachability over a NEW connection before
#  committing.
#
#  Operations (JSON on stdin, JSON on stdout; stdlib only):
#    stage    — validate and install a revision, arm timer
#    commit   — cancel the timer, discard the backup
#    rollback — restore the backup now, cancel the timer
#    status   — report the current transaction, if any
#
#  Used by:
#    - apply_gateway_forced_command.py — pushes this file to
#      the guest over SSH on every backend apply call, so
#      the guest can never drift onto a stale applier
############################################################


import datetime
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

# Everything transactional lives under /run — tmpfs — so a reboot clears a
# half-finished transaction together with the timer that guarded it.
STATE_DIR = Path("/run/virtual-lab-gateway")
BACKUP_DIR = STATE_DIR / "backup"
STAGE_DIR = STATE_DIR / "stage"
TRANSACTION_FILE = STATE_DIR / "transaction.json"
ROLLBACK_UNIT = "virtual-lab-gateway-rollback"
ROLLBACK_SCRIPT = STATE_DIR / "rollback.sh"

MAX_REQUEST_BYTES = 512 * 1024
MANAGED_TABLE = "virtual_lab_gateway"
REVISION_PATTERN = re.compile(r"Gateway desired-state revision ([0-9a-f]{64})")

# Only these paths may be written. The applier runs as root, so this is not a
# privilege boundary; it is a contract boundary. A request that names anything
# else is a bug or a mistake, and silently writing it would put files on the
# guest that no renderer knows how to remove.
ALLOWED_EXACT = {
    "/etc/nftables.d/virtual-lab-gateway.nft",
    "/etc/dnsmasq.d/virtual-lab-gateway.conf",
    "/etc/squid/squid.conf",
    "/etc/sysctl.d/99-virtual-lab-gateway.conf",
}
# Gateway VLAN subinterfaces are named after the trunk parent, e.g. ens19.2000 --
# NOT after the VNet. An earlier `50-lab\d{4}` pattern here matched the VNet
# naming instead and rejected every file the renderer actually produces, which
# stayed invisible for as long as there were no groups: with none allocated the
# renderer emits no VLAN files at all, so the allowlist was never exercised.
# The interface alphabet MUST stay in step with validateInterfaceName in
# backend/src/network/gateway-desired-state.ts (^[A-Za-z][A-Za-z0-9_-]{0,14}$).
# A narrower alphabet here does not fail safe: the backend accepts a name like
# `br-lab` or `ens19_0`, renders paths for it, and the applier then refuses every
# one of them, so the plan looks healthy and can never converge.
INTERFACE = r"[A-Za-z][A-Za-z0-9_-]{0,14}"
ALLOWED_PATTERNS = [
    re.compile(rf"^/etc/systemd/network/50-{INTERFACE}\.\d{{4}}\.(netdev|network)$"),
    # The trunk parent's own unit. Named distinctly so the prune sweep below can
    # never mistake a distro- or operator-managed `.network` for one of ours.
    re.compile(rf"^/etc/systemd/network/50-virtual-lab-{INTERFACE}\.network$"),
]

MIN_ROLLBACK_SECONDS = 60
MAX_ROLLBACK_SECONDS = 1800








############################################################
# ApplyError
############################################################
#
# A failure that should be reported to the caller as a clean
# stderr line and exit code — not a crash with a traceback.
############################################################

class ApplyError(Exception):
    pass








############################################################
# run
############################################################
#
# The shared subprocess wrapper: captured output, text mode,
# a 60 s default timeout, check=True unless the caller opts
# out.
#
# Used by:
#   - nearly every function in this file
############################################################

def run(command: list[str], *, check: bool = True, timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run(command, check=check, capture_output=True, text=True, timeout=timeout)








############################################################
# allowed
############################################################
#
# True when a requested path is one of the four exact
# managed files or matches a managed VLAN-unit pattern.
#
# Used by:
#   - operation_stage (below) — rejects unmanaged paths
############################################################

def allowed(path: str) -> bool:
    return path in ALLOWED_EXACT or any(pattern.fullmatch(path) for pattern in ALLOWED_PATTERNS)








############################################################
# existing_variable_paths
############################################################
#
# Managed paths that vary with desired state and currently
# exist on disk. Only the pattern-matched paths are
# enumerated: the four exact files are emitted by every full
# render, so treating them as prunable would let a partial
# request delete squid.conf. The VLAN files are the ones
# that legitimately disappear when a group is released.
#
# Used by:
#   - operation_stage (below) — computes the prune set
############################################################

def existing_variable_paths() -> list[str]:
    found = []
    for directory in (Path("/etc/systemd/network"),):
        if not directory.is_dir():
            continue
        for candidate in directory.rglob("*"):
            if candidate.is_file() and any(
                pattern.fullmatch(str(candidate)) for pattern in ALLOWED_PATTERNS
            ):
                found.append(str(candidate))
    return sorted(found)








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
        raise ApplyError("request exceeds the maximum size")
    request = json.loads(raw)
    if request.get("version") != 1 or request.get("target") != "gateway":
        raise ApplyError("unsupported request")
    if request.get("operation") not in {"stage", "commit", "rollback", "status"}:
        raise ApplyError("unsupported operation")
    if not re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
        str(request.get("request_id", "")),
        re.IGNORECASE,
    ):
        raise ApplyError("invalid request ID")
    return request








############################################################
# read_transaction
############################################################
#
# The staged transaction record, or None when nothing is
# staged.
#
# Used by:
#   - operation_stage / commit / rollback / status (below)
############################################################

def read_transaction() -> dict[str, Any] | None:
    try:
        return json.loads(TRANSACTION_FILE.read_text())
    except FileNotFoundError:
        return None








############################################################
# timer_active
############################################################
#
# True while the rollback timer is armed — the window in
# which a staged transaction still awaits its commit.
#
# Used by:
#   - operation_stage (below) — refuses to stack transactions
#   - every operation's response (the rollback_armed field)
############################################################

def timer_active() -> bool:
    result = run(["systemctl", "is-active", f"{ROLLBACK_UNIT}.timer"], check=False)
    return result.stdout.strip() == "active"








############################################################
# live_revision
############################################################
#
# The desired-state revision embedded in the live managed
# table, or None when the table is absent or carries no
# revision comment.
#
# Used by:
#   - verify, operation_rollback, operation_status (below)
############################################################

def live_revision() -> str | None:
    tables = run(["nft", "list", "tables"]).stdout
    if f"table inet {MANAGED_TABLE}" not in tables:
        return None
    match = REVISION_PATTERN.search(run(["nft", "list", "table", "inet", MANAGED_TABLE]).stdout)
    return match.group(1) if match else None








############################################################
# validate_staged
############################################################
#
# Offline validation of staged content. Every validator here
# is necessary but not sufficient: `squid -k parse` in
# particular never binds a socket, so a port collision
# passes parse and only fatals at start — the service
# restart in reload_services is the real gate.
#
# Used by:
#   - operation_stage (below)
############################################################

def validate_staged(files: dict[str, str]) -> list[str]:
    performed = []
    nft_path = STAGE_DIR / "virtual-lab-gateway.nft"
    if nft_path.exists():
        run(["nft", "-c", "-f", str(nft_path)])
        performed.append("nft -c")
    squid_path = STAGE_DIR / "squid.conf"
    if squid_path.exists():
        run(["squid", "-k", "parse", "-f", str(squid_path)], timeout=90)
        performed.append("squid -k parse")
    dnsmasq_path = STAGE_DIR / "virtual-lab-gateway.conf"
    if dnsmasq_path.exists():
        run(["dnsmasq", "--test", f"--conf-file={dnsmasq_path}"])
        performed.append("dnsmasq --test")
    if not performed:
        raise ApplyError("no recognised configuration files were staged")
    return performed








############################################################
# arm_rollback
############################################################
#
# Writes and schedules the restore, before anything is
# installed. The script restores from the backup captured in
# this transaction rather than re-deriving desired state, so
# it puts back exactly what was in force.
#
# Used by:
#   - operation_stage (below)
############################################################

def arm_rollback(seconds: int, paths: list[str]) -> None:
    lines = ["#!/bin/sh", "# Automatic rollback for a Gateway policy apply.", "set -e", ""]
    for path in paths:
        backup = BACKUP_DIR / path.lstrip("/").replace("/", "_")
        if backup.exists():
            lines.append(f"cp {backup} {path}")
        else:
            # The file did not exist before this transaction, so restoring means
            # removing it. Otherwise a rolled-back apply leaves debris behind.
            lines.append(f"rm -f {path}")
            # Removing a .netdev file does not remove the interface it created:
            # networkd creates netdevs and never destroys them. Without this a
            # rolled-back apply leaves a live VLAN subinterface holding the
            # group's Gateway address that no file describes -- which the prune
            # sweep, being file-derived, can never reach.
            netdev = VLAN_NETDEV.match(Path(path).name)
            if netdev:
                lines.append(f"ip link delete dev {netdev.group(1)} 2>/dev/null || true")
    if any(path.startswith("/etc/systemd/network/") for path in paths):
        lines.append("networkctl reload || true")
    lines += [
        "sysctl --system >/dev/null 2>&1 || true",
        "systemctl restart dnsmasq || true",
        "systemctl restart squid || true",
        "nft -f /etc/nftables.conf || true",
        f"rm -f {TRANSACTION_FILE}",
        "",
    ]
    ROLLBACK_SCRIPT.write_text("\n".join(lines))
    ROLLBACK_SCRIPT.chmod(0o700)
    run([
        "systemd-run",
        f"--on-active={seconds}",
        f"--unit={ROLLBACK_UNIT}",
        "/bin/sh", str(ROLLBACK_SCRIPT),
    ])








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








# `50-<parent>.<vlan>.netdev` -> `<parent>.<vlan>`. Only names derived from a
# pruned managed path are ever passed to `ip link delete`.
VLAN_NETDEV = re.compile(rf"^50-({INTERFACE}\.\d{{4}})\.netdev$")








############################################################
# remove_pruned_vlan_links
############################################################
#
# Deletes the VLAN interfaces whose .netdev files this
# transaction removed. systemd-networkd creates netdevs but
# never destroys them: removing the file and reloading
# leaves the interface up and carrying an address, so a
# released group's VLAN would stay live on the Gateway until
# the next reboot. Verification would catch it — it observes
# the interface after the files are gone — but catching it
# means the apply fails rather than converges, so the link
# has to be removed here.
#
# The rollback needs no counterpart: restoring the .netdev
# file and reloading recreates the interface, which is how
# networkd made it in the first place.
#
# Used by:
#   - reload_services (below)
############################################################

def remove_pruned_vlan_links(pruned: list[str]) -> list[str]:
    removed = []
    for path in pruned:
        match = VLAN_NETDEV.match(Path(path).name)
        if not match:
            continue
        interface = match.group(1)
        # Confirmed to be a VLAN before deletion, so a name collision with a
        # physical NIC can never take the host off the network.
        details = run(["ip", "-d", "link", "show", "dev", interface], check=False)
        if details.returncode != 0 or "vlan " not in details.stdout:
            continue
        run(["ip", "link", "delete", "dev", interface])
        removed.append(interface)
    return removed








############################################################
# reload_services
############################################################
#
# Reloads what the staged paths actually affect. networkd is
# reloaded only when networkd files were staged, and it is
# done FIRST: a VLAN subinterface must exist before dnsmasq
# binds to its address. Without this a group's networkd
# files would be written and never take effect — invisible
# until the first group is allocated.
#
# Used by:
#   - operation_stage (below)
############################################################

def reload_services(paths: list[str], pruned: list[str] | None = None) -> list[str]:
    reloaded = []
    if any(path.startswith("/etc/systemd/network/") for path in paths):
        run(["networkctl", "reload"])
        reloaded.append("networkd")
        for interface in remove_pruned_vlan_links(pruned or []):
            reloaded.append(f"removed:{interface}")
    run(["sysctl", "--system"])
    reloaded.append("sysctl")
    run(["systemctl", "restart", "dnsmasq"])
    reloaded.append("dnsmasq")
    run(["systemctl", "restart", "squid"], timeout=90)
    reloaded.append("squid")
    run(["nft", "-f", "/etc/nftables.conf"])
    reloaded.append("nftables")
    return reloaded








############################################################
# verify
############################################################
#
# Confirms the services actually run and the kernel carries
# the requested revision.
#
# Used by:
#   - operation_stage, operation_commit (below)
############################################################

def verify(revision: str) -> dict[str, Any]:
    inactive = [
        service for service in ("nftables", "dnsmasq", "squid")
        if run(["systemctl", "is-active", service], check=False).stdout.strip() != "active"
    ]
    observed = live_revision()
    return {
        "services_inactive": inactive,
        "observed_revision": observed,
        "revision_matches": observed == revision,
        "converged": not inactive and observed == revision,
    }








############################################################
# operation_stage
############################################################
#
# The main event: back up, install, arm the dead-man's
# switch. Everything before arm_rollback may raise freely;
# everything after it runs under the timer, so a crash there
# still converges back on its own.
#
# Used by:
#   - main (below) — operation "stage"
############################################################

def operation_stage(request: dict[str, Any]) -> dict[str, Any]:
    # STEP 1: validate the request — revision shape, non-empty
    # files, every path inside the managed allowlist
    # ========================================================
    revision = request.get("revision", "")
    if not re.fullmatch(r"[0-9a-f]{64}", str(revision)):
        raise ApplyError("revision must be a 64 character hex digest")
    files = request.get("files")
    if not isinstance(files, dict) or not files:
        raise ApplyError("files must be a non-empty object")
    rejected = [path for path in files if not allowed(path)]
    if rejected:
        raise ApplyError(f"refusing to write unmanaged path(s): {', '.join(sorted(rejected)[:5])}")


    # STEP 2: refuse to stack transactions — a staged apply with
    # a live timer must commit or roll back first
    # ==========================================================
    existing = read_transaction()
    if existing and timer_active():
        raise ApplyError(
            f"transaction {existing['transaction_id']} is still awaiting commit or rollback",
        )


    # STEP 3: bound the rollback window
    # =================================
    rollback_seconds = int(request.get("rollback_seconds", 300))
    if not MIN_ROLLBACK_SECONDS <= rollback_seconds <= MAX_ROLLBACK_SECONDS:
        raise ApplyError(
            f"rollback_seconds must be between {MIN_ROLLBACK_SECONDS} and {MAX_ROLLBACK_SECONDS}",
        )


    # STEP 4: start from clean stage/backup directories
    # =================================================
    for directory in (STAGE_DIR, BACKUP_DIR):
        shutil.rmtree(directory, ignore_errors=True)
        directory.mkdir(parents=True, exist_ok=True)
    STATE_DIR.chmod(0o700)


    # STEP 5: stage the candidates and back up every file this
    # transaction touches — overwrites and prunes alike
    # ========================================================
    # A group that was released leaves managed VLAN files behind: the renderer
    # emits nothing for it, so writing alone can never converge. Anything managed
    # and no longer desired is removed as part of the same transaction.
    prune = [path for path in existing_variable_paths() if path not in files]

    # Stage under the basename each validator expects, then back up whatever is
    # currently in force so the rollback restores reality, not an assumption.
    for path, content in sorted(files.items()):
        (STAGE_DIR / Path(path).name).write_text(content)
        source = Path(path)
        if source.exists():
            shutil.copy2(source, BACKUP_DIR / path.lstrip("/").replace("/", "_"))
    for path in prune:
        shutil.copy2(path, BACKUP_DIR / path.lstrip("/").replace("/", "_"))


    # STEP 6: validate offline, then arm the dead-man's switch —
    # from here on a crash rolls itself back
    # ==========================================================
    validators = validate_staged(files)
    # The rollback must cover pruned paths too, or an abandoned transaction would
    # leave the guest missing files it had before.
    arm_rollback(rollback_seconds, sorted([*files, *prune]))


    # STEP 7: install the new files and delete the pruned ones
    # ========================================================
    for path, content in sorted(files.items()):
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        target.chmod(0o644)

    for path in prune:
        Path(path).unlink(missing_ok=True)


    # STEP 8: make it live — service reloads — and verify
    # ===================================================
    reloaded = reload_services(sorted([*files, *prune]), prune)
    verification = verify(str(revision))


    # STEP 9: record the transaction for commit/rollback
    # ==================================================
    transaction_id = f"gw-{datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    transaction = {
        "transaction_id": transaction_id,
        "revision": revision,
        "paths": sorted(files),
        "pruned": prune,
        "rollback_seconds": rollback_seconds,
        "staged_at": datetime.datetime.now(datetime.timezone.utc)
        .isoformat()
        .replace("+00:00", "Z"),
        "digests": {
            path: hashlib.sha256(content.encode()).hexdigest()
            for path, content in sorted(files.items())
        },
    }
    TRANSACTION_FILE.write_text(json.dumps(transaction, sort_keys=True))

    # A failed verification is NOT rolled back here. The timer already owns that
    # decision, and letting it fire gives the caller the same outcome without a
    # second failure path that could itself fail halfway.
    return {
        "transaction_id": transaction_id,
        "revision": revision,
        "validators": validators,
        "pruned": prune,
        "reloaded": reloaded,
        "verification": verification,
        "rollback_armed": timer_active(),
        "rollback_seconds": rollback_seconds,
    }








############################################################
# operation_commit
############################################################
#
# Makes a staged transaction permanent — but only a
# converged one: committing an unconverged apply would keep
# a broken ruleset and cancel the very timer that would have
# fixed it.
#
# Used by:
#   - main (below) — operation "commit"
############################################################

def operation_commit(request: dict[str, Any]) -> dict[str, Any]:
    transaction = read_transaction()
    if not transaction:
        raise ApplyError("no transaction is staged")
    requested = request.get("transaction_id")
    if requested != transaction["transaction_id"]:
        raise ApplyError("transaction ID does not match the staged transaction")

    # Re-verify at commit time. The caller may have proven reachability, but the
    # ruleset could still have failed a service after staging returned.
    verification = verify(transaction["revision"])
    if not verification["converged"]:
        raise ApplyError(
            "refusing to commit a transaction that is not converged; let the rollback fire",
        )

    cancel_rollback()
    shutil.rmtree(BACKUP_DIR, ignore_errors=True)
    TRANSACTION_FILE.unlink(missing_ok=True)
    return {
        "transaction_id": transaction["transaction_id"],
        "revision": transaction["revision"],
        "committed": True,
        "rollback_armed": timer_active(),
        "verification": verification,
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
        raise ApplyError("no transaction is staged")
    requested = request.get("transaction_id")
    if requested and requested != transaction["transaction_id"]:
        raise ApplyError("transaction ID does not match the staged transaction")

    run(["/bin/sh", str(ROLLBACK_SCRIPT)])
    cancel_rollback()
    return {
        "transaction_id": transaction["transaction_id"],
        "rolled_back": True,
        "observed_revision": live_revision(),
        "rollback_armed": timer_active(),
    }








############################################################
# operation_status
############################################################
#
# Read-only report: staged transaction, timer state, live
# revision.
#
# Used by:
#   - main (below) — operation "status"
############################################################

def operation_status(_request: dict[str, Any]) -> dict[str, Any]:
    transaction = read_transaction()
    return {
        "transaction": transaction,
        "rollback_armed": timer_active(),
        "observed_revision": live_revision(),
    }








############################################################
# main
############################################################
#
# Root check, request parsing, operation dispatch, and the
# JSON envelope on stdout.
#
# Used by:
#   - the __main__ guard — this file is pushed to the guest
#     and executed by apply_gateway_forced_command.py
############################################################

def main() -> None:
    if os.geteuid() != 0:
        raise ApplyError("the Gateway applier must run as root")
    request = parse_request()
    handlers = {
        "stage": operation_stage,
        "commit": operation_commit,
        "rollback": operation_rollback,
        "status": operation_status,
    }
    result = handlers[request["operation"]](request)
    print(json.dumps({
        "version": 1,
        "request_id": request["request_id"],
        "target": "gateway",
        "operation": request["operation"],
        "captured_at": datetime.datetime.now(datetime.timezone.utc)
        .isoformat()
        .replace("+00:00", "Z"),
        **result,
    }, sort_keys=True, separators=(",", ":")))








# Known failure types become one stderr line and exit 1; the forced command
# forwards that stderr to the backend verbatim.
if __name__ == "__main__":
    try:
        main()
    except (ApplyError, ValueError, json.JSONDecodeError, OSError, subprocess.SubprocessError) as error:
        detail = str(error)
        if isinstance(error, subprocess.CalledProcessError):
            detail = f"{error.cmd[0]} failed: {(error.stderr or error.stdout or '').strip()}"
        print(f"Gateway apply failed: {detail[:800]}", file=sys.stderr)
        raise SystemExit(1)
