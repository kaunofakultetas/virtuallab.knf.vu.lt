#!/usr/bin/env python3
############################################################
#  [*] Access apply — policy installer inside LXC 200
#
#  Applies rendered Access policy with a dead-man's switch.
#  Mirrors infra/gateway/apply_gateway.py: stage, validate
#  offline, arm an automatic rollback, install, reload,
#  verify — and let the caller commit only after proving the
#  result independently.
#
#  Access is administered through `pct exec`, not SSH, so a
#  bad ruleset cannot lock the orchestrator out the way it
#  could on the Gateway. The rollback timer is kept anyway,
#  because the failure that matters here is different: this
#  LXC runs Guacamole, and a ruleset that breaks it would
#  break student access until someone noticed.
#
#  Operations (JSON on stdin, JSON on stdout):
#    stage    — back up, install, arm the rollback timer
#    commit   — cancel the timer, drop the backups
#    rollback — restore now instead of waiting for the timer
#    status   — transaction, timer and live-revision report
#
#  Used by:
#    - apply_access_forced_command.py — pipes this file into
#      the LXC over `pct exec` on every backend apply call,
#      so the guest never holds (or runs) a stale copy
############################################################


import datetime
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

# Everything transactional lives under /run — tmpfs — so a reboot clears a
# half-finished transaction together with the timer that guarded it.
STATE_DIR = Path("/run/virtual-lab-access")
BACKUP_DIR = STATE_DIR / "backup"
STAGE_DIR = STATE_DIR / "stage"
TRANSACTION_FILE = STATE_DIR / "transaction.json"
ROLLBACK_UNIT = "virtual-lab-access-rollback"
ROLLBACK_SCRIPT = STATE_DIR / "rollback.sh"

MAX_REQUEST_BYTES = 512 * 1024
MANAGED_TABLE = "virtual_lab_access"
NFTABLES_CONF = Path("/etc/nftables.conf")
NFTABLES_INCLUDE = 'include "/etc/nftables.d/*.nft"'
# Loaded directly, never via NFTABLES_CONF. That file begins with
# `flush ruleset`, which would take Docker's `ip nat` MASQUERADE rules with it
# and silently cut Guacamole off from every student VM until dockerd restarts.
# The rendered file carries its own create-then-delete prelude so loading it
# alone is idempotent.
MANAGED_NFT = Path("/etc/nftables.d/virtual-lab-access.nft")
REVISION_PATTERN = re.compile(r"Access desired-state revision ([0-9a-f]{64})")

ALLOWED_EXACT = {
    "/etc/nftables.d/virtual-lab-access.nft",
    "/etc/sysctl.d/99-virtual-lab-access.conf",
}
# Access VLAN subinterfaces are named after the trunk parent, e.g. eth1.2000.
INTERFACE = r"[A-Za-z][A-Za-z0-9_-]{0,14}"
ALLOWED_PATTERNS = [
    re.compile(rf"^/etc/systemd/network/50-{INTERFACE}\.\d{{4}}\.(netdev|network)$"),
    # The trunk parent's own unit, which replaced the drop-in below. Named
    # distinctly so the prune sweep can never mistake a PVE-generated or
    # operator-managed `.network` for one of ours.
    re.compile(rf"^/etc/systemd/network/50-virtual-lab-{INTERFACE}\.network$"),
    # Retained solely so the superseded drop-in gets pruned. The renderer no
    # longer emits it; without this pattern it would sit on disk forever,
    # declaring VLANs beside a file we no longer rely on.
    re.compile(r"^/etc/systemd/network/[a-z0-9]+\.network\.d/50-virtual-lab-vlans\.conf$"),
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
# True when a requested path is one of the two exact managed
# files or matches a managed VLAN-unit pattern.
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
# Managed VLAN paths currently on disk. Only pattern-matched
# paths are prunable; the two exact files are emitted by
# every full render, so treating them as prunable would let
# a partial request delete the ruleset itself.
#
# Used by:
#   - operation_stage (below) — computes the prune set
############################################################

def existing_variable_paths() -> list[str]:
    directory = Path("/etc/systemd/network")
    if not directory.is_dir():
        return []
    return sorted(
        str(candidate)
        for candidate in directory.rglob("*")
        if candidate.is_file()
        and any(pattern.fullmatch(str(candidate)) for pattern in ALLOWED_PATTERNS)
    )








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
    if request.get("version") != 1 or request.get("target") != "access":
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
    return run(["systemctl", "is-active", f"{ROLLBACK_UNIT}.timer"], check=False).stdout.strip() == "active"








############################################################
# live_revision
############################################################
#
# The desired-state revision embedded in the live managed
# table, or None when the table is absent. A managed table
# WITHOUT a revision comment is an error — someone edited it
# by hand.
#
# Used by:
#   - verify, operation_rollback, operation_status (below)
############################################################

def live_revision() -> str | None:
    tables = run(["nft", "list", "tables"]).stdout
    if f"table inet {MANAGED_TABLE}" not in tables:
        return None
    match = REVISION_PATTERN.search(run(["nft", "list", "table", "inet", MANAGED_TABLE]).stdout)
    if match is None:
        raise ApplyError("managed nftables table carries no desired-state revision comment")
    return match.group(1)








############################################################
# ensure_nftables_include
############################################################
#
# Makes /etc/nftables.d/*.nft load at boot. The August
# transaction wrote the ruleset there but never added the
# include, so the table vanished on the next restart and
# never came back — writing a file the boot path ignores is
# indistinguishable from working until a reboot.
#
# Used by:
#   - operation_stage (below)
############################################################

def ensure_nftables_include() -> bool:
    content = NFTABLES_CONF.read_text() if NFTABLES_CONF.exists() else "#!/usr/sbin/nft -f\n"
    if NFTABLES_INCLUDE in content:
        return False
    if not content.endswith("\n"):
        content += "\n"
    NFTABLES_CONF.write_text(f"{content}{NFTABLES_INCLUDE}\n")
    return True








############################################################
# validate_staged
############################################################
#
# Offline validation of the staged candidates: `nft -c` for
# the ruleset, a content check for the sysctl file. Staging
# nothing recognisable is an error, not a no-op.
#
# Used by:
#   - operation_stage (below)
############################################################

def validate_staged() -> list[str]:
    performed = []
    nft_path = STAGE_DIR / "virtual-lab-access.nft"
    if nft_path.exists():
        run(["nft", "-c", "-f", str(nft_path)])
        performed.append("nft -c")
    sysctl_path = STAGE_DIR / "99-virtual-lab-access.conf"
    if sysctl_path.exists():
        if "net.ipv4.ip_forward = 1" not in sysctl_path.read_text():
            raise ApplyError("sysctl candidate does not enable IPv4 forwarding")
        performed.append("sysctl content check")
    if not performed:
        raise ApplyError("no recognised configuration files were staged")
    return performed








############################################################
# arm_rollback
############################################################
#
# Schedules the restore on a transient systemd timer.
#
# `remove_include` matters more than it looks: if this
# transaction adds the nftables include, a rollback that
# leaves it behind would start loading the restored file at
# boot — turning "never loaded" into "loads an old
# revision". The restore has to undo the include too, or it
# is not a restore.
#
# Used by:
#   - operation_stage (below)
############################################################

def arm_rollback(seconds: int, paths: list[str], *, remove_include: bool) -> None:
    lines = ["#!/bin/sh", "# Automatic rollback for an Access policy apply.", "set -e", ""]
    for path in paths:
        backup = BACKUP_DIR / path.lstrip("/").replace("/", "_")
        if backup.exists():
            lines.append(f"cp {backup} {path}")
        else:
            lines.append(f"rm -f {path}")
            # Removing a .netdev file does not remove the interface it created:
            # networkd creates netdevs and never destroys them. Without this a
            # rolled-back apply leaves a live VLAN subinterface holding the
            # group's Access address that no file describes -- which the prune
            # sweep, being file-derived, can never reach.
            netdev = VLAN_NETDEV.match(Path(path).name)
            if netdev:
                lines.append(f"ip link delete dev {netdev.group(1)} 2>/dev/null || true")
    if remove_include:
        # grep -vF, not sed: the include line contains double quotes and glob
        # characters, and an earlier sed form silently failed under `|| true`,
        # leaving the include behind and turning a rollback into a change.
        quoted = shlex.quote(NFTABLES_INCLUDE)
        lines.append(
            f"grep -vF {quoted} {NFTABLES_CONF} > {NFTABLES_CONF}.rollback "
            f"&& mv {NFTABLES_CONF}.rollback {NFTABLES_CONF}",
        )
    if any(path.startswith("/etc/systemd/network/") for path in paths):
        lines.append("networkctl reload || true")
    lines += [
        "sysctl --system >/dev/null 2>&1 || true",
        # Restoring means the previous ruleset, which may have been no table at
        # all. Flush ours first so a rollback to "absent" really is absent.
        f"nft delete table inet {MANAGED_TABLE} 2>/dev/null || true",
        f"[ -f {MANAGED_NFT} ] && nft -f {MANAGED_NFT} || true",
        f"rm -f {TRANSACTION_FILE}",
        "",
    ]
    ROLLBACK_SCRIPT.write_text("\n".join(lines))
    ROLLBACK_SCRIPT.chmod(0o700)
    run(["systemd-run", f"--on-active={seconds}", f"--unit={ROLLBACK_UNIT}", "/bin/sh", str(ROLLBACK_SCRIPT)])








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
# released group's VLAN would stay live on the Access LXC
# until the next reboot. Verification would catch it — it
# observes the interface after the files are gone — but
# catching it means the apply fails rather than converges,
# so the link has to be removed here.
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
# Pushes the installed files into the running system:
# networkd reload (plus pruned-VLAN link removal), sysctl,
# and the nftables ruleset — or table deletion, when a prune
# converges on "no managed table".
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
    if MANAGED_NFT.exists():
        run(["nft", "-f", str(MANAGED_NFT)])
    else:
        # Converging on "no managed table" is a legitimate outcome of a prune.
        run(["nft", "delete", "table", "inet", MANAGED_TABLE], check=False)
    reloaded.append("nftables")
    return reloaded








############################################################
# verify
############################################################
#
# Confirms the ruleset is loaded and Guacamole's ports still
# answer. The service check matters more here than on the
# Gateway: this LXC is the student access path, and a
# converged ruleset that silently stopped serving would be
# worse than a failed apply.
#
# Used by:
#   - operation_stage, operation_commit (below)
############################################################

def verify(revision: str) -> dict[str, Any]:
    observed = live_revision()
    listeners = run(["ss", "-Hlnt"], check=False).stdout
    serving = [port for port in ("8080", "9443") if f":{port} " in listeners]
    return {
        "observed_revision": observed,
        "revision_matches": observed == revision,
        "service_ports_listening": serving,
        "converged": observed == revision and len(serving) == 2,
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
    revision = str(request.get("revision", ""))
    if not re.fullmatch(r"[0-9a-f]{64}", revision):
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
        raise ApplyError(f"transaction {existing['transaction_id']} is still awaiting commit or rollback")


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
    prune = [path for path in existing_variable_paths() if path not in files]

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
    validators = validate_staged()
    # Captured before arming, because the rollback must know whether the
    # include is this transaction's doing or was already there.
    include_present_before = (
        NFTABLES_CONF.exists() and NFTABLES_INCLUDE in NFTABLES_CONF.read_text()
    )
    arm_rollback(
        rollback_seconds,
        sorted([*files, *prune]),
        remove_include=not include_present_before,
    )


    # STEP 7: install the new files and delete the pruned ones
    # ========================================================
    for path, content in sorted(files.items()):
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        target.chmod(0o644)
    for path in prune:
        Path(path).unlink(missing_ok=True)


    # STEP 8: make it live — boot include, service reloads —
    # and verify the result
    # ======================================================
    include_added = ensure_nftables_include()
    reloaded = reload_services(sorted([*files, *prune]), prune)
    verification = verify(revision)


    # STEP 9: record the transaction for commit/rollback
    # ==================================================
    transaction_id = f"ax-{datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    TRANSACTION_FILE.write_text(json.dumps({
        "transaction_id": transaction_id,
        "revision": revision,
        "paths": sorted(files),
        "pruned": prune,
        "rollback_seconds": rollback_seconds,
        "staged_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "digests": {
            path: hashlib.sha256(content.encode()).hexdigest()
            for path, content in sorted(files.items())
        },
    }, sort_keys=True))

    return {
        "transaction_id": transaction_id,
        "revision": revision,
        "validators": validators,
        "pruned": prune,
        "reloaded": reloaded,
        "nftables_include_added": include_added,
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
    if request.get("transaction_id") != transaction["transaction_id"]:
        raise ApplyError("transaction ID does not match the staged transaction")

    verification = verify(transaction["revision"])
    if not verification["converged"]:
        raise ApplyError("refusing to commit a transaction that is not converged; let the rollback fire")

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
# revision, and whether the boot include is present.
#
# Used by:
#   - main (below) — operation "status"
############################################################

def operation_status(_request: dict[str, Any]) -> dict[str, Any]:
    return {
        "transaction": read_transaction(),
        "rollback_armed": timer_active(),
        "observed_revision": live_revision(),
        "nftables_include_present": NFTABLES_CONF.exists()
        and NFTABLES_INCLUDE in NFTABLES_CONF.read_text(),
    }








############################################################
# main
############################################################
#
# Root check, request parsing, operation dispatch, and the
# JSON envelope on stdout.
#
# Used by:
#   - the __main__ guard — this file is executed inside the
#     LXC by apply_access_forced_command.py
############################################################

def main() -> None:
    if os.geteuid() != 0:
        raise ApplyError("the Access applier must run as root")
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
        "target": "access",
        "operation": request["operation"],
        "captured_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
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
        print(f"Access apply failed: {detail[:800]}", file=sys.stderr)
        raise SystemExit(1)
