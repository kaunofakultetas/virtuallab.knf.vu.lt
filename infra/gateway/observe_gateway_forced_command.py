#!/usr/bin/env python3
############################################################
#  [*] Gateway observe — forced command on the Proxmox host
#
#  The read-only half of Gateway reconciliation. Runs under
#  a dedicated authorized_keys entry, so the key the
#  orchestrator holds can do exactly this and nothing else:
#  read VM 202's persistent configuration through pvesh/qm,
#  run the guest-side observer (observe_gateway.py) inside
#  the VM, and return both as one document.
#
#  VM 202 has no QEMU guest agent, so unlike the Access
#  observer this reaches the guest over SSH using the host's
#  own key. That is the same trust relationship the
#  hypervisor already has: host root controls the VM and its
#  disk regardless, so this grants no privilege it lacked.
#
#  Mutates nothing. Returns digests of managed files rather
#  than their content.
#
#  Used by:
#    - backend gateway-clients.ts createGatewayObserver —
#      the read-only SSH principal for reconciliation
#      dry-runs
############################################################


import datetime
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any


VMID = 202
GUEST_ADDRESS = os.environ.get("GATEWAY_GUEST_ADDRESS", "10.10.10.2")
GUEST_USER = os.environ.get("GATEWAY_GUEST_USER", "gateway-admin")
GUEST_OBSERVER = Path("/usr/local/libexec/virtual-lab/observe_gateway.py")
MAX_REQUEST_BYTES = 4096
PROXMOX_NODE_NAME = os.environ.get("PROXMOX_NODE_NAME", "")








############################################################
# run
############################################################
#
# The shared subprocess wrapper: check=True, captured text
# output, a 12 s default timeout.
#
# Used by:
#   - observe_guest, main (below)
############################################################

def run(command: list[str], *, input_text: str | None = None, timeout: int = 12) -> str:
    result = subprocess.run(
        command,
        check=True,
        capture_output=True,
        input=input_text,
        text=True,
        timeout=timeout,
    )
    return result.stdout








############################################################
# parse_request
############################################################
#
# Accepts exactly one request shape — the fixed observe call
# with a strict UUID request ID — and rejects any extra or
# missing field by name-set comparison.
#
# Used by:
#   - main (below)
############################################################

def parse_request(raw: bytes) -> dict[str, Any]:
    if len(raw) > MAX_REQUEST_BYTES:
        raise ValueError("request exceeds the maximum size")
    request = json.loads(raw)
    if set(request) != {"version", "request_id", "target", "operation"}:
        raise ValueError("request has unknown or missing fields")
    if request["version"] != 1 or request["target"] != "gateway" or request["operation"] != "observe":
        raise ValueError("unsupported request")
    if not re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
        request["request_id"],
        re.IGNORECASE,
    ):
        raise ValueError("invalid request ID")
    return request








############################################################
# parse_network_device
############################################################
#
# Parses a QEMU netN value such as
# 'virtio=BC:24:11:..,bridge=vmbr1,firewall=1' into the
# fields reconciliation compares. A malformed or duplicate
# field is an error, not a shrug.
#
# Used by:
#   - main (below)
############################################################

def parse_network_device(value: str) -> dict[str, Any]:
    fields: dict[str, str] = {}
    for field in value.split(","):
        key, separator, field_value = field.partition("=")
        if not separator or not key or key in fields:
            raise ValueError("malformed or duplicate network device field")
        fields[key] = field_value
    trunks_text = fields.get("trunks", "")
    trunks = [] if not trunks_text else [int(item) for item in trunks_text.split(";")]
    if len(trunks) != len(set(trunks)) or any(vlan < 1 or vlan > 4094 for vlan in trunks):
        raise ValueError("network device contains invalid trunks")
    return {
        "bridge": fields.get("bridge"),
        "firewall": fields.get("firewall") == "1",
        # link_down is present only when the NIC is disconnected, so its absence
        # means connected. Report the positive form to keep the contract explicit.
        "connected": fields.get("link_down") != "1",
        "trunks": sorted(trunks),
    }








############################################################
# observe_guest
############################################################
#
# Pushes the checked-in guest observer over SSH stdin and
# runs it in one call, so the guest never holds a copy.
#
# Used by:
#   - main (below)
############################################################

def observe_guest() -> dict[str, Any]:
    source = GUEST_OBSERVER.read_text()
    output = run(
        [
            "ssh",
            "-T",
            "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=yes",
            "-o", "ConnectTimeout=5",
            f"{GUEST_USER}@{GUEST_ADDRESS}",
            # Privileged: the observer reads the live nftables ruleset and the
            # managed files, none of which are visible to an unprivileged user.
            # Running it unprivileged silently reports "no policy applied".
            "sudo -n python3 -",
        ],
        input_text=source,
        timeout=30,
    )
    return json.loads(output)








############################################################
# main
############################################################
#
# One observation round trip: config via pvesh (digest
# mandatory), running check, the netN/ipconfigN views, then
# the guest observer — any failure is fatal, because a
# partial observation is not an observation.
#
# Used by:
#   - the __main__ guard
############################################################

def main() -> None:
    # STEP 1: validate the request and the pinned node name
    # =====================================================
    request = parse_request(sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1))
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]{0,62}", PROXMOX_NODE_NAME):
        raise ValueError("PROXMOX_NODE_NAME is missing or malformed")


    # STEP 2: the Proxmox-owned half — config digest, running
    # status, every netN and ipconfigN entry
    # =======================================================
    config = json.loads(run([
        "pvesh", "get", f"/nodes/{PROXMOX_NODE_NAME}/qemu/{VMID}/config", "--output-format", "json",
    ]))
    digest = config.get("digest")
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{40}", digest):
        raise ValueError("VM config digest is missing or malformed")

    status_output = run(["qm", "status", str(VMID)]).strip()
    if status_output != "status: running":
        raise ValueError("Gateway VM is not running")

    network_devices = {
        key: parse_network_device(value)
        for key, value in sorted(config.items())
        if re.fullmatch(r"net\d+", key) and isinstance(value, str)
    }
    ip_config = {
        key: value
        for key, value in sorted(config.items())
        if re.fullmatch(r"ipconfig\d+", key) and isinstance(value, str)
    }


    # STEP 3: the guest half, then one combined JSON answer
    # =====================================================
    response = {
        "version": 1,
        "request_id": request["request_id"],
        "target": "gateway",
        "operation": "observe",
        "captured_at": datetime.datetime.now(datetime.timezone.utc)
        .isoformat()
        .replace("+00:00", "Z"),
        "vmid": VMID,
        "status": "running",
        "config_digest": digest,
        "network_devices": network_devices,
        "ip_config": ip_config,
        "guest": observe_guest(),
        "errors": [],
    }
    print(json.dumps(response, sort_keys=True, separators=(",", ":")))








if __name__ == "__main__":
    try:
        main()
    except (ValueError, json.JSONDecodeError, OSError, subprocess.SubprocessError) as error:
        print(f"Gateway observation failed: {str(error)[:500]}", file=sys.stderr)
        raise SystemExit(1)
