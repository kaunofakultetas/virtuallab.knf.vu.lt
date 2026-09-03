#!/usr/bin/env python3
############################################################
#  [*] Access apply — forced command on the Proxmox host
#
#  Forwards an Access apply request into LXC 200. Runs under
#  its own authorized_keys entry, separate from every
#  read-only principal, so the mutating capability can be
#  revoked on its own.
#
#  Unlike the Gateway, the guest is reached with `pct exec`
#  rather than SSH, so the applier (apply_access.py) is
#  piped in on stdin along with the request in a single
#  call: the guest needs no persistent copy and cannot run a
#  stale one.
#
#  Reads JSON on stdin, returns the guest's JSON answer
#  verbatim.
#
#  Used by:
#    - backend access-clients.ts createAccessApplier — the
#      SSH principal the backend dials for stage/commit/
#      rollback/status calls
############################################################


import json
import re
import subprocess
import sys
from pathlib import Path

VMID = 200
APPLIER = Path("/usr/local/libexec/virtual-lab/apply_access.py")
MAX_REQUEST_BYTES = 512 * 1024








############################################################
# main
############################################################
#
# Validates the request just enough to refuse garbage early
# (the guest applier re-validates everything), checks the
# LXC is running, then splices the applier and the request
# into one stdin payload for a single `pct exec` round trip.
#
# Used by:
#   - the __main__ guard
############################################################

def main() -> None:
    # STEP 1: bounded read and shape checks — version, target,
    # operation, strict UUID request ID
    # ========================================================
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        raise ValueError("request exceeds the maximum size")
    request = json.loads(raw)
    if request.get("version") != 1 or request.get("target") != "access":
        raise ValueError("unsupported request")
    if request.get("operation") not in {"stage", "commit", "rollback", "status"}:
        raise ValueError("unsupported operation")
    if not re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
        str(request.get("request_id", "")),
        re.IGNORECASE,
    ):
        raise ValueError("invalid request ID")


    # STEP 2: refuse to talk to a stopped guest
    # =========================================
    status = subprocess.run(["pct", "status", str(VMID)], check=True, capture_output=True, text=True)
    if status.stdout.strip() != "status: running":
        raise ValueError("Access LXC is not running")


    # STEP 3: one `pct exec` carries everything — the awk in the
    # guest splits the payload at the marker line, writes the
    # applier and the request to /run, and runs the applier
    # ==========================================================
    # The applier is written to the guest and executed in one shell, so the copy
    # it runs is always the one held here. /run is tmpfs, so it does not persist.
    remote = "/run/virtual-lab-access-applier.py"
    payload = f"{APPLIER.read_text()}\n#__REQUEST__\n{json.dumps(request)}\n"
    script = (
        f"awk '/^#__REQUEST__$/{{found=1;next}} !found{{print > \"{remote}\"}} "
        f"found{{print}}' > /run/virtual-lab-access-request.json && "
        f"python3 {remote} < /run/virtual-lab-access-request.json"
    )
    result = subprocess.run(
        ["pct", "exec", str(VMID), "--", "sh", "-c", script],
        check=True,
        capture_output=True,
        input=payload,
        text=True,
        timeout=180,
    )
    sys.stdout.write(result.stdout)








# Known failure types become one stderr line and exit 1 — that line is what
# the backend's SSH client reports on a failed apply call.
if __name__ == "__main__":
    try:
        main()
    except (ValueError, json.JSONDecodeError, OSError, subprocess.SubprocessError) as error:
        detail = str(error)
        if isinstance(error, subprocess.CalledProcessError):
            detail = (error.stderr or error.stdout or "").strip() or detail
        print(f"Access apply forwarding failed: {detail[:800]}", file=sys.stderr)
        raise SystemExit(1)
