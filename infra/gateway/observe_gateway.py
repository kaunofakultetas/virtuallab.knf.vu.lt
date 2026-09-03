#!/usr/bin/env python3
############################################################
#  [*] Gateway observe — read-only collector inside VM 202
#
#  Prints a single JSON document describing the state the
#  orchestrator needs in order to decide whether the guest
#  matches desired state. It mutates nothing and reads no
#  secret material: the managed configuration files are
#  reported as SHA-256 digests rather than content, so a
#  drift comparison never transports policy or credentials
#  over the observation channel.
#
#  Standard library only, because the guest carries no
#  application dependencies.
#
#  Used by:
#    - observe_gateway_forced_command.py — pushes this file
#      to the guest over SSH and runs it for the backend
#      reconciliation dry-run
############################################################


import datetime
import hashlib
import json
import pathlib
import re
import subprocess
from typing import Any

# The renderer's managed paths. A digest per path is what makes drift precise:
# the desired-state revision alone cannot distinguish "never applied" from
# "applied then edited by hand".
MANAGED_PATHS = [
    "/etc/nftables.d/virtual-lab-gateway.nft",
    "/etc/dnsmasq.d/virtual-lab-gateway.conf",
    "/etc/squid/squid.conf",
    "/etc/sysctl.d/99-virtual-lab-gateway.conf",
]

# The networkd files the renderer emits per group, which cannot be a fixed list
# because their names carry the VLAN tag. They are enumerated rather than
# assumed, so a file left behind by a released group is reported as present and
# the applier's prune has something to act on.
#
# These patterns MUST stay in step with ALLOWED_PATTERNS in apply_gateway.py. If
# the observer reported fewer paths than the applier writes, every rendered VLAN
# file would read as absent no matter what landed on disk, and an apply could
# never converge -- which is exactly the failure that hid behind an empty group
# list until the first group was allocated.
NETWORKD_DIRECTORY = "/etc/systemd/network"
NETWORKD_PATTERNS = [
    re.compile(r"^50-[a-z0-9]+\.\d{4}\.(netdev|network)$"),
    re.compile(r"^50-virtual-lab-[a-z0-9]+\.network$"),
]

MANAGED_TABLE = "virtual_lab_gateway"
SERVICES = ["nftables", "dnsmasq", "squid"]
REVISION_PATTERN = re.compile(r"Gateway desired-state revision ([0-9a-f]{64})")








############################################################
# run
############################################################
#
# The shared subprocess wrapper: captured text output, a
# hard 12 s timeout, check=True unless the caller opts out.
#
# Used by:
#   - every observe_* function in this file
############################################################

def run(command: list[str], *, check: bool = True) -> str:
    result = subprocess.run(
        command,
        check=check,
        capture_output=True,
        text=True,
        timeout=12,
    )
    return result.stdout








############################################################
# digest_of
############################################################
#
# Digest of a managed file, or None when it genuinely does
# not exist. A file that exists but cannot be read raises
# instead of returning None: conflating "absent" with
# "unreadable" would report drift that an applier then tries
# to fix forever.
#
# Used by:
#   - observe_managed_files (below)
############################################################

def digest_of(path: str) -> str | None:
    try:
        with open(path, "rb") as handle:
            return hashlib.sha256(handle.read()).hexdigest()
    except FileNotFoundError:
        return None








############################################################
# observe_managed_files
############################################################
#
# Digests of every managed file: the fixed four plus
# whatever networkd files are on disk.
#
# The fixed paths are reported even when absent, because
# "the renderer always emits this and it is missing" is
# itself the finding. The networkd paths are reported only
# when they exist, because their names depend on which
# groups are allocated, and inventing entries for tags
# nobody asked for would report drift against files that
# were never meant to exist.
#
# Used by:
#   - main (below)
############################################################

def observe_managed_files() -> dict[str, str | None]:
    files: dict[str, str | None] = {path: digest_of(path) for path in MANAGED_PATHS}
    directory = pathlib.Path(NETWORKD_DIRECTORY)
    if directory.is_dir():
        for candidate in sorted(directory.iterdir()):
            if candidate.is_file() and any(
                pattern.fullmatch(candidate.name) for pattern in NETWORKD_PATTERNS
            ):
                files[str(candidate)] = digest_of(str(candidate))
    return files








############################################################
# observe_interfaces
############################################################
#
# Every interface but lo, with its IPv4 addresses, parent
# and operstate.
#
# Used by:
#   - main (below)
############################################################

def observe_interfaces() -> list[dict[str, Any]]:
    # Deliberately not `-4`: that filters out interfaces holding no IPv4
    # address, which would hide the VLAN trunk parent entirely. Addresses are
    # filtered to inet below instead.
    entries = json.loads(run(["ip", "-j", "addr", "show"]))
    interfaces = []
    for entry in entries:
        name = entry.get("ifname")
        if not isinstance(name, str) or name == "lo":
            continue
        addresses = sorted(
            f"{info['local']}/{info['prefixlen']}"
            for info in entry.get("addr_info", [])
            if info.get("family") == "inet" and "local" in info and "prefixlen" in info
        )
        interfaces.append({
            "name": name,
            "addresses": addresses,
            # link_type/link tells us a VLAN's parent; ip -j reports the parent
            # as "link" only for virtual interfaces, so absence means physical.
            "parent": entry.get("link"),
            "operstate": entry.get("operstate", "UNKNOWN"),
        })
    return sorted(interfaces, key=lambda item: item["name"])








############################################################
# observe_vlans
############################################################
#
# VLAN subinterfaces only, with their tag, so desired VLANs
# can be compared.
#
# Used by:
#   - main (below)
############################################################

def observe_vlans() -> list[dict[str, Any]]:
    entries = json.loads(run(["ip", "-j", "-d", "link", "show", "type", "vlan"], check=False) or "[]")
    vlans = []
    for entry in entries:
        name = entry.get("ifname")
        info = entry.get("linkinfo", {}).get("info_data", {})
        vlan_id = info.get("id")
        if isinstance(name, str) and isinstance(vlan_id, int):
            vlans.append({"name": name, "vlan_id": vlan_id, "parent": entry.get("link")})
    return sorted(vlans, key=lambda item: item["vlan_id"])








############################################################
# observe_default_routes
############################################################
#
# The IPv4 default routes as gateway/interface pairs.
#
# Used by:
#   - main (below)
############################################################

def observe_default_routes() -> list[dict[str, str]]:
    entries = json.loads(run(["ip", "-j", "-4", "route", "show", "default"]))
    return sorted(
        (
            {"gateway": entry["gateway"], "interface": entry["dev"]}
            for entry in entries
            if "gateway" in entry and "dev" in entry
        ),
        key=lambda item: (item["interface"], item["gateway"]),
    )








############################################################
# observe_nftables_revision
############################################################
#
# The revision the running ruleset claims, read from the
# table comment — from the LIVE ruleset rather than the file
# on disk: a file can be correct while the kernel still runs
# something else entirely.
#
# `nft list tables` is queried first so that "the table is
# absent" (a real, reportable state) is never confused with
# "nft could not run" (an observation failure). Returning
# None for the latter would look exactly like unapplied
# policy and trigger an endless re-apply.
#
# Used by:
#   - main (below)
############################################################

def observe_nftables_revision() -> str | None:
    tables = run(["nft", "list", "tables"])
    if f"table inet {MANAGED_TABLE}" not in tables:
        return None
    match = REVISION_PATTERN.search(run(["nft", "list", "table", "inet", MANAGED_TABLE]))
    if match is None:
        raise ValueError("managed nftables table carries no desired-state revision comment")
    return match.group(1)








############################################################
# observe_services
############################################################
#
# active/enabled per managed service — both, because a
# service can run now yet not survive a reboot, and the
# other way round.
#
# Used by:
#   - main (below)
############################################################

def observe_services() -> dict[str, dict[str, bool]]:
    services = {}
    for service in SERVICES:
        active = run(["systemctl", "is-active", service], check=False).strip() == "active"
        enabled = run(["systemctl", "is-enabled", service], check=False).strip() == "enabled"
        services[service] = {"active": active, "enabled": enabled}
    return services








############################################################
# split_socket
############################################################
#
# Splits an ss endpoint into address and port. Handles IPv6
# (`[::]:53`), interface scopes (`127.0.0.53%lo:53`) and the
# wildcard (`*:22`). Raises on anything it does not
# understand, because a silently skipped listener is a
# listener nobody knows about.
#
# Used by:
#   - observe_listeners (below)
############################################################

def split_socket(endpoint: str) -> tuple[str, int]:
    address, separator, port_text = endpoint.rpartition(":")
    if not separator:
        raise ValueError(f"unparsable socket endpoint: {endpoint}")
    address = address.strip("[]").split("%", 1)[0]
    return (address or "*", int(port_text))








############################################################
# observe_listeners
############################################################
#
# TCP and UDP listening sockets, so exposure can be
# asserted, not assumed. ss on Ubuntu 24.04 has no JSON
# output, so this parses the text form. It runs with
# check=True: an empty listener list must mean "nothing is
# listening", never "the command failed", or an exposure
# check would pass vacuously.
#
# Used by:
#   - main (below)
############################################################

def observe_listeners() -> list[dict[str, Any]]:
    listeners = []
    for protocol, flag in (("tcp", "-Hlnt"), ("udp", "-Hlnu")):
        for line in run(["ss", flag]).splitlines():
            fields = line.split()
            if len(fields) < 4:
                continue
            # State Recv-Q Send-Q Local:Port Peer:Port ...
            address, port = split_socket(fields[3])
            listeners.append({"protocol": protocol, "address": address, "port": port})
    return sorted(listeners, key=lambda item: (item["protocol"], item["port"], item["address"]))








############################################################
# observe_sysctl
############################################################
#
# The two kernel switches policy asserts: IPv4 forwarding on
# and IPv6 off.
#
# Used by:
#   - main (below)
############################################################

def observe_sysctl() -> dict[str, bool]:
    def read(name: str) -> str:
        return run(["sysctl", "-n", name], check=False).strip()

    return {
        "ipv4_forwarding": read("net.ipv4.ip_forward") == "1",
        "ipv6_disabled": read("net.ipv6.conf.all.disable_ipv6") == "1",
    }








############################################################
# main
############################################################
#
# Assembles the observation document and prints it as one
# compact sorted-keys JSON line.
#
# Used by:
#   - the __main__ guard
############################################################

def main() -> None:
    document = {
        "version": 1,
        "captured_at": datetime.datetime.now(datetime.timezone.utc)
        .isoformat()
        .replace("+00:00", "Z"),
        "interfaces": observe_interfaces(),
        "vlan_interfaces": observe_vlans(),
        "default_routes": observe_default_routes(),
        "nftables_revision": observe_nftables_revision(),
        "managed_files": observe_managed_files(),
        "services": observe_services(),
        "listeners": observe_listeners(),
        "sysctl": observe_sysctl(),
    }
    print(json.dumps(document, sort_keys=True, separators=(",", ":")))








if __name__ == "__main__":
    main()
