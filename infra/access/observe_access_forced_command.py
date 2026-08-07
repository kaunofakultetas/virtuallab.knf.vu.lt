#!/usr/bin/env python3

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
GUEST_OBSERVER = Path("/usr/local/libexec/virtual-lab/observe_access.py")
MAX_REQUEST_BYTES = 4096
PROXMOX_NODE_NAME = os.environ.get("PROXMOX_NODE_NAME", "")


def run(command: list[str], *, input_text: str | None = None) -> str:
    result = subprocess.run(
        command,
        check=True,
        capture_output=True,
        input=input_text,
        text=True,
        timeout=12,
    )
    return result.stdout


def parse_request(raw: bytes) -> dict[str, Any]:
    if len(raw) > MAX_REQUEST_BYTES:
        raise ValueError("request exceeds the maximum size")
    request = json.loads(raw)
    if set(request) != {"version", "request_id", "target", "operation"}:
        raise ValueError("request has unknown or missing fields")
    if request["version"] != 1 or request["target"] != "access" or request["operation"] != "observe":
        raise ValueError("unsupported request")
    if not re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
        request["request_id"],
        re.IGNORECASE,
    ):
        raise ValueError("invalid request ID")
    return request


def parse_net1(value: str) -> dict[str, Any]:
    fields: dict[str, str] = {}
    for field in value.split(","):
        key, separator, field_value = field.partition("=")
        if not separator or not key or key in fields:
            raise ValueError("malformed or duplicate net1 field")
        fields[key] = field_value
    if not fields.get("name") or not fields.get("bridge"):
        raise ValueError("net1 is missing name or bridge")
    trunks_text = fields.get("trunks", "")
    trunks = [] if not trunks_text else [int(value) for value in trunks_text.split(";")]
    if len(trunks) != len(set(trunks)) or any(vlan < 1 or vlan > 4094 for vlan in trunks):
        raise ValueError("net1 contains invalid trunks")
    return {
        "name": fields["name"],
        "bridge": fields["bridge"],
        "ip": fields.get("ip"),
        "trunks": sorted(trunks),
    }


def parse_bridge_vlans(output: str) -> list[int]:
    entries = json.loads(output)
    matching = [entry for entry in entries if entry.get("ifname") == HOST_VETH]
    if len(matching) != 1:
        raise ValueError("live host veth observation is missing or duplicated")
    vlans = [
        item["vlan"]
        for item in matching[0].get("vlans", [])
        if "PVID" not in item.get("flags", [])
        and "Egress Untagged" not in item.get("flags", [])
    ]
    if any(not isinstance(vlan, int) or vlan < 1 or vlan > 4094 for vlan in vlans):
        raise ValueError("live host veth contains an invalid VLAN")
    return sorted(set(vlans))


def main() -> None:
    request = parse_request(sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1))
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]{0,62}", PROXMOX_NODE_NAME):
        raise ValueError("PROXMOX_NODE_NAME is missing or malformed")
    config = json.loads(run([
        "pvesh", "get", f"/nodes/{PROXMOX_NODE_NAME}/lxc/{VMID}/config", "--output-format", "json",
    ]))
    digest = config.get("digest")
    net1 = config.get("net1")
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{40}", digest):
        raise ValueError("LXC config digest is missing or malformed")
    if not isinstance(net1, str):
        raise ValueError("LXC config net1 is missing")
    status_output = run(["pct", "status", str(VMID)]).strip()
    if status_output != "status: running":
        raise ValueError("Access LXC is not running")
    run(["ip", "link", "show", "dev", HOST_VETH])
    live_vlans = parse_bridge_vlans(run(["bridge", "-j", "vlan", "show", "dev", HOST_VETH]))
    guest_source = GUEST_OBSERVER.read_text()
    guest = json.loads(run(
        ["pct", "exec", str(VMID), "--", "python3", "-"],
        input_text=guest_source,
    ))
    response = {
        "version": 1,
        "request_id": request["request_id"],
        "target": "access",
        "operation": "observe",
        "captured_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "vmid": VMID,
        "status": "running",
        "config_digest": digest,
        "net1": parse_net1(net1),
        "host_veth": {
            "name": HOST_VETH,
            "exists": True,
            "vlan_ids": live_vlans,
        },
        "guest": guest,
        "errors": [],
    }
    print(json.dumps(response, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, json.JSONDecodeError, OSError, subprocess.SubprocessError) as error:
        print(f"Access observation failed: {str(error)[:500]}", file=sys.stderr)
        raise SystemExit(1)