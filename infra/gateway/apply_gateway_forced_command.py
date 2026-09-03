#!/usr/bin/env python3
############################################################
#  [*] Gateway apply — forced command on the Proxmox host
#
#  Forwards a Gateway apply request into VM 202. Runs under
#  its own authorized_keys entry, separate from the
#  read-only observer principal, so the mutating capability
#  is a distinct key that can be revoked on its own.
#
#  The applier itself (apply_gateway.py) is pushed to the
#  guest on every call from the copy held here, so the host
#  stays the single source of truth and the guest can never
#  drift onto a stale applier. It lands in /run — tmpfs —
#  so it does not persist.
#
#  Reads the request as JSON on stdin and returns the
#  guest's JSON answer verbatim.
#
#  Used by:
#    - backend gateway-clients.ts createGatewayApplier — the
#      SSH principal the backend dials for stage/commit/
#      rollback/status calls
############################################################


import json
import os
import re
import subprocess
import sys
from pathlib import Path

GUEST_ADDRESS = os.environ.get("GATEWAY_GUEST_ADDRESS", "10.10.10.2")
GUEST_USER = os.environ.get("GATEWAY_GUEST_USER", "gateway-admin")
APPLIER = Path("/usr/local/libexec/virtual-lab/apply_gateway.py")
REMOTE_APPLIER = "/run/virtual-lab-gateway-applier.py"
MAX_REQUEST_BYTES = 512 * 1024

SSH_ARGS = [
    "ssh",
    "-T",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=5",
]








############################################################
# guest
############################################################
#
# One SSH command on the Gateway guest, with the given stdin
# and a hard timeout. BatchMode and strict host-key checking
# are non-negotiable: this key can mutate the Gateway.
#
# Used by:
#   - main (below) — once to install, once to run
############################################################

def guest(command: str, *, input_text: str, timeout: int) -> str:
    result = subprocess.run(
        [*SSH_ARGS, f"{GUEST_USER}@{GUEST_ADDRESS}", command],
        check=True,
        capture_output=True,
        input=input_text,
        text=True,
        timeout=timeout,
    )
    return result.stdout








############################################################
# main
############################################################
#
# Validates the request just enough to refuse garbage early
# (the guest applier re-validates everything), pushes the
# applier, then runs it with the request on stdin.
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
    if request.get("version") != 1 or request.get("target") != "gateway":
        raise ValueError("unsupported request")
    if request.get("operation") not in {"stage", "commit", "rollback", "status"}:
        raise ValueError("unsupported operation")
    if not re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
        str(request.get("request_id", "")),
        re.IGNORECASE,
    ):
        raise ValueError("invalid request ID")


    # STEP 2: push this host's copy of the applier, then run it
    # =========================================================
    guest(
        f"sudo -n install -D -m 0700 /dev/stdin {REMOTE_APPLIER}",
        input_text=APPLIER.read_text(),
        timeout=30,
    )
    # Generous, because staging restarts Squid, which is the slowest step.
    answer = guest(
        f"sudo -n /usr/bin/python3 {REMOTE_APPLIER}",
        input_text=json.dumps(request),
        timeout=180,
    )
    sys.stdout.write(answer)








# Known failure types become one stderr line and exit 1 — that line is what
# the backend's SSH client reports on a failed apply call.
if __name__ == "__main__":
    try:
        main()
    except (ValueError, json.JSONDecodeError, OSError, subprocess.SubprocessError) as error:
        detail = str(error)
        if isinstance(error, subprocess.CalledProcessError):
            detail = (error.stderr or error.stdout or "").strip() or detail
        print(f"Gateway apply forwarding failed: {detail[:800]}", file=sys.stderr)
        raise SystemExit(1)
