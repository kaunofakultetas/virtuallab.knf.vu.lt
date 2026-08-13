#!/usr/bin/env python3

"""Forced command that forwards a Gateway apply request into VM 202.

Runs on the Proxmox host under its own authorized_keys entry, separate from the
read-only observer principal, so the mutating capability is a distinct key that
can be revoked on its own.

The applier itself is pushed to the guest on every call from the copy held here,
so the host stays the single source of truth and the guest can never drift onto
a stale applier. It lands in /run, which is tmpfs, so it does not persist.

Reads the request as JSON on stdin and returns the guest's JSON answer verbatim.
"""

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


def main() -> None:
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


if __name__ == "__main__":
    try:
        main()
    except (ValueError, json.JSONDecodeError, OSError, subprocess.SubprocessError) as error:
        detail = str(error)
        if isinstance(error, subprocess.CalledProcessError):
            detail = (error.stderr or error.stdout or "").strip() or detail
        print(f"Gateway apply forwarding failed: {detail[:800]}", file=sys.stderr)
        raise SystemExit(1)
