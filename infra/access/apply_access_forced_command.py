#!/usr/bin/env python3

"""Forced command that forwards an Access apply request into LXC 200.

Runs on the Proxmox host under its own authorized_keys entry, separate from
every read-only principal, so the mutating capability can be revoked on its own.

Unlike the Gateway, the guest is reached with `pct exec` rather than SSH, so the
applier is piped in on stdin along with the request in a single call: the guest
needs no persistent copy and cannot run a stale one.

Reads JSON on stdin, returns the guest's JSON answer verbatim.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

VMID = 200
APPLIER = Path("/usr/local/libexec/virtual-lab/apply_access.py")
MAX_REQUEST_BYTES = 512 * 1024


def main() -> None:
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

    status = subprocess.run(["pct", "status", str(VMID)], check=True, capture_output=True, text=True)
    if status.stdout.strip() != "status: running":
        raise ValueError("Access LXC is not running")

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


if __name__ == "__main__":
    try:
        main()
    except (ValueError, json.JSONDecodeError, OSError, subprocess.SubprocessError) as error:
        detail = str(error)
        if isinstance(error, subprocess.CalledProcessError):
            detail = (error.stderr or error.stdout or "").strip() or detail
        print(f"Access apply forwarding failed: {detail[:800]}", file=sys.stderr)
        raise SystemExit(1)
