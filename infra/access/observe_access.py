#!/usr/bin/env python3

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


def ipv4(value: str) -> str | None:
    value = value.strip("[]")
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return None
    return str(address) if address.version == 4 else None


def endpoint(value: str) -> tuple[str, int] | None:
    host, separator, port_text = value.rpartition(":")
    if not separator or not port_text.isdigit():
        return None
    address = ipv4(host)
    return (address, int(port_text)) if address is not None else None


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


def interfaces(errors: list[str]) -> list[dict[str, Any]]:
    output = run(["ip", "-j", "-4", "address", "show"], errors)
    if output is None:
        return []
    try:
        return parse_interfaces(output)
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
        errors.append(f"cannot parse ip address output: {error}")
        return []


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


def conntrack_state() -> list[dict[str, Any]]:
    for path in (Path("/proc/net/nf_conntrack"), Path("/proc/net/ip_conntrack")):
        try:
            return parse_conntrack(path.read_text())
        except FileNotFoundError:
            continue
    return []


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


def sysctl_boolean(name: str, true_value: str, errors: list[str]) -> bool:
    output = run(["sysctl", "-n", name], errors)
    return output is not None and output.strip() == true_value


def nftables(errors: list[str]) -> dict[str, Any]:
    output = run(["nft", "list", "ruleset"], errors)
    return {
        "available": output is not None,
        "ruleset": output or "",
    }


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