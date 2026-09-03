#!/usr/bin/env python3
############################################################
#  [*] Access observe — read-only collector inside LXC 200
#
#  Captures the Access LXC's network reality as one JSON
#  document on stdout: interfaces, Docker bridge subnets,
#  service listeners and their client sources, forwarding
#  sysctls, and the full nftables ruleset. Root is needed
#  for the ruleset, Docker state and conntrack.
#
#  Changes nothing. Collectors append to a shared `errors`
#  list instead of raising — a non-empty errors array means
#  the observation is incomplete and must fail readiness,
#  but every collector that could run still reports.
#
#  Each collector is split into a pure parse_* half (unit
#  tested) and a thin half that shells out.
#
#  Used by:
#    - observe_access_forced_command.py — runs this through
#      `pct exec` for the backend reconciliation dry-run
#    - observe-access.sh — the manual operator wrapper
#    - test_observe_access.py — the parse_* halves
############################################################


import datetime
import ipaddress
import json
import re
import signal
import socket
import subprocess
from pathlib import Path
from typing import Any


SERVICE_PORTS = {8080, 9443}








############################################################
# run
############################################################
#
# The shared subprocess wrapper for this collector: stdout
# on success, None on failure — with the failure appended to
# `errors` instead of raised, so one missing tool does not
# abort the whole observation.
#
# Used by:
#   - every shelling collector in this file
############################################################

def run(command: list[str], errors: list[str]) -> str | None:
    try:
        result = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
        )
        return result.stdout
    except FileNotFoundError:
        errors.append(f"command not found: {command[0]}")
    except subprocess.CalledProcessError as error:
        detail = error.stderr.strip() or error.stdout.strip() or f"exit {error.returncode}"
        errors.append(f"{' '.join(command)}: {detail}")
    return None








############################################################
# ipv4
############################################################
#
# The normalised IPv4 address out of a raw string, or None —
# IPv6 (bracketed or not) and garbage both come back None,
# so callers filter on a single check.
#
# Used by:
#   - endpoint, parse_conntrack, parse_packet_capture (below)
############################################################

def ipv4(value: str) -> str | None:
    value = value.strip("[]")
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return None
    return str(address) if address.version == 4 else None








############################################################
# endpoint
############################################################
#
# "address:port" → (address, port), or None when either half
# does not parse. rpartition, not split: the address half
# may itself contain colons.
#
# Used by:
#   - parse_socket_state (below)
############################################################

def endpoint(value: str) -> tuple[str, int] | None:
    host, separator, port_text = value.rpartition(":")
    if not separator or not port_text.isdigit():
        return None
    address = ipv4(host)
    return (address, int(port_text)) if address is not None else None








############################################################
# parse_interfaces
############################################################
#
# `ip -j -4 address show` JSON → sorted name/addresses
# pairs, IPv4 only.
#
# Used by:
#   - interfaces (below)
#   - test_observe_access.py
############################################################

def parse_interfaces(output: str) -> list[dict[str, Any]]:
    data = json.loads(output)
    return sorted(
        [
            {
                "name": item["ifname"],
                "addresses": sorted(
                    f"{address['local']}/{address['prefixlen']}"
                    for address in item.get("addr_info", [])
                    if address.get("family") == "inet"
                ),
            }
            for item in data
        ],
        key=lambda item: item["name"],
    )








############################################################
# interfaces
############################################################
#
# The shelling half of parse_interfaces; parse failures are
# reported through `errors`, not raised.
#
# Used by:
#   - main (below)
############################################################

def interfaces(errors: list[str]) -> list[dict[str, Any]]:
    output = run(["ip", "-j", "-4", "address", "show"], errors)
    if output is None:
        return []
    try:
        return parse_interfaces(output)
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
        errors.append(f"cannot parse ip address output: {error}")
        return []








############################################################
# parse_docker_bridge_cidrs
############################################################
#
# `docker network inspect` JSON → the sorted IPv4 subnets of
# bridge-driver networks. Normalised through ip_network so
# a host-address form like 172.18.0.1/16 comes out as the
# network 172.18.0.0/16.
#
# Used by:
#   - docker_bridge_cidrs (below)
#   - test_observe_access.py
############################################################

def parse_docker_bridge_cidrs(output: str) -> list[str]:
    networks = json.loads(output)
    cidrs = {
        str(ipaddress.ip_network(config["Subnet"], strict=False))
        for network in networks
        if network.get("Driver") == "bridge"
        for config in network.get("IPAM", {}).get("Config", [])
        if config.get("Subnet") and ipaddress.ip_network(config["Subnet"], strict=False).version == 4
    }
    return sorted(cidrs)








############################################################
# docker_bridge_cidrs
############################################################
#
# The shelling half of parse_docker_bridge_cidrs: list the
# network IDs first, then inspect them all in one call.
#
# Used by:
#   - main (below)
############################################################

def docker_bridge_cidrs(errors: list[str]) -> list[str]:
    network_ids = run(["docker", "network", "ls", "--quiet"], errors)
    if network_ids is None:
        return []
    identifiers = network_ids.split()
    if not identifiers:
        return []
    output = run(["docker", "network", "inspect", *identifiers], errors)
    if output is None:
        return []
    try:
        return parse_docker_bridge_cidrs(output)
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
        errors.append(f"cannot parse Docker network output: {error}")
        return []








############################################################
# parse_socket_state
############################################################
#
# `ss -H -4 -tna` output → (listeners, connections) for the
# service ports only. Connections seen here carry the post-
# DNAT source; the true client address comes from conntrack
# or the packet capture (below).
#
# Used by:
#   - socket_state (below)
#   - test_observe_access.py
############################################################

def parse_socket_state(output: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    listeners: set[tuple[int, str]] = set()
    connections: set[tuple[int, str]] = set()
    for line in output.splitlines():
        fields = line.split()
        if len(fields) < 5:
            continue
        state = fields[0]
        local = endpoint(fields[3])
        remote = endpoint(fields[4])
        if local is None or local[1] not in SERVICE_PORTS:
            continue
        if state == "LISTEN":
            listeners.add((local[1], local[0]))
        elif remote is not None:
            connections.add((local[1], remote[0]))
    return (
        [
            {"port": port, "local_address": address}
            for port, address in sorted(listeners)
        ],
        [
            {"local_port": port, "remote_address": address}
            for port, address in sorted(connections)
        ],
    )








############################################################
# parse_conntrack
############################################################
#
# /proc/net/nf_conntrack lines → service-port connections
# keyed by the ORIGINAL source address. Only the first
# src/dst tuple per line is read (a repeated key means the
# reply tuple has started): that is the pre-DNAT view, the
# client as it really is before Docker rewrites it.
#
# Used by:
#   - conntrack_state (below)
#   - test_observe_access.py
############################################################

def parse_conntrack(output: str) -> list[dict[str, Any]]:
    connections: set[tuple[int, str]] = set()
    for line in output.splitlines():
        fields = line.split()
        if "tcp" not in fields or len(fields) < 8:
            continue
        first_tuple: dict[str, str] = {}
        for field in fields:
            key, separator, value = field.partition("=")
            if not separator:
                continue
            if key in first_tuple:
                break
            first_tuple[key] = value
        source = ipv4(first_tuple.get("src", ""))
        destination_port = first_tuple.get("dport", "")
        if source is not None and destination_port.isdigit():
            port = int(destination_port)
            if port in SERVICE_PORTS:
                connections.add((port, source))
    return [
        {"local_port": port, "remote_address": address}
        for port, address in sorted(connections)
    ]








############################################################
# conntrack_state
############################################################
#
# Reads whichever conntrack proc file this kernel exposes;
# an empty result (no file, or no flows) tells socket_state
# to fall back to the packet capture.
#
# Used by:
#   - socket_state (below)
############################################################

def conntrack_state() -> list[dict[str, Any]]:
    for path in (Path("/proc/net/nf_conntrack"), Path("/proc/net/ip_conntrack")):
        try:
            return parse_conntrack(path.read_text())
        except FileNotFoundError:
            continue
    return []








############################################################
# parse_packet_capture
############################################################
#
# tcpdump text → service-port connections by source address.
# Matches only inbound "IP src.port > dst.SERVICEPORT:"
# lines, so chatter on other ports never registers.
#
# Used by:
#   - packet_capture (below)
#   - test_observe_access.py
############################################################

def parse_packet_capture(output: str) -> list[dict[str, Any]]:
    connections: set[tuple[int, str]] = set()
    pattern = re.compile(
        r"\bIP (?P<source>\d+(?:\.\d+){3})\.\d+ > "
        r"\d+(?:\.\d+){3}\.(?P<port>8080|9443):",
    )
    for match in pattern.finditer(output):
        source = ipv4(match.group("source"))
        if source is not None:
            connections.add((int(match.group("port")), source))
    return [
        {"local_port": port, "remote_address": address}
        for port, address in sorted(connections)
    ]








############################################################
# packet_capture
############################################################
#
# The passive fallback when conntrack shows nothing: watch
# eth0 — the management interface, BEFORE Docker DNAT — for
# five seconds of service traffic. SIGINT on timeout, not
# kill: tcpdump then flushes and exits 0/130, both of which
# count as success.
#
# Used by:
#   - socket_state (below)
############################################################

def packet_capture(errors: list[str], duration_seconds: int = 5) -> list[dict[str, Any]]:
    command = [
        "tcpdump",
        "-nn",
        "-l",
        "-i",
        "eth0",
        "tcp dst port 8080 or tcp dst port 9443",
    ]
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            stdout, stderr = process.communicate(timeout=duration_seconds)
        except subprocess.TimeoutExpired:
            process.send_signal(signal.SIGINT)
            stdout, stderr = process.communicate()
        if process.returncode not in (0, 130):
            detail = stderr.strip() or f"exit {process.returncode}"
            errors.append(f"{' '.join(command)}: {detail}")
            return []
        return parse_packet_capture(stdout)
    except FileNotFoundError:
        errors.append("command not found: tcpdump")
        return []








############################################################
# socket_state
############################################################
#
# Listeners plus the merged connection view: socket-level
# connections (post-DNAT), overlaid with the original client
# sources from conntrack — or from a live capture when
# conntrack has no matching flow.
#
# Used by:
#   - main (below)
############################################################

def socket_state(errors: list[str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    output = run(["ss", "-H", "-4", "-tna"], errors)
    listeners, socket_connections = (
        parse_socket_state(output) if output is not None else ([], [])
    )
    observed_connections = conntrack_state()
    if not observed_connections:
        observed_connections = packet_capture(errors)
    connections = {
        (connection["local_port"], connection["remote_address"])
        for connection in [*socket_connections, *observed_connections]
    }
    return listeners, [
        {"local_port": port, "remote_address": address}
        for port, address in sorted(connections)
    ]








############################################################
# sysctl_boolean
############################################################
#
# True when the named sysctl reads exactly `true_value` —
# note the ipv6_enabled caller inverts the sense by asking
# whether disable_ipv6 is "0".
#
# Used by:
#   - main (below)
############################################################

def sysctl_boolean(name: str, true_value: str, errors: list[str]) -> bool:
    output = run(["sysctl", "-n", name], errors)
    return output is not None and output.strip() == true_value








############################################################
# nftables
############################################################
#
# The complete ruleset as text, with an availability flag so
# "no nft" and "empty ruleset" stay distinguishable.
#
# Used by:
#   - main (below)
############################################################

def nftables(errors: list[str]) -> dict[str, Any]:
    output = run(["nft", "list", "ruleset"], errors)
    return {
        "available": output is not None,
        "ruleset": output or "",
    }








############################################################
# main
############################################################
#
# Assembles the observation document and prints it as one
# sorted-keys JSON line.
#
# Used by:
#   - the __main__ guard
############################################################

def main() -> None:
    errors: list[str] = []
    listeners, connections = socket_state(errors)
    observation = {
        "version": 1,
        "captured_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "hostname": socket.gethostname(),
        "interfaces": interfaces(errors),
        "docker_bridge_cidrs": docker_bridge_cidrs(errors),
        "listeners": listeners,
        "connections": connections,
        "sysctl": {
            "ipv4_forwarding": sysctl_boolean("net.ipv4.ip_forward", "1", errors),
            "ipv6_enabled": sysctl_boolean("net.ipv6.conf.all.disable_ipv6", "0", errors),
        },
        "nftables": nftables(errors),
        "errors": errors,
    }
    print(json.dumps(observation, sort_keys=True))








if __name__ == "__main__":
    main()
