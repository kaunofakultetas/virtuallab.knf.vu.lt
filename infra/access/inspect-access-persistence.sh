#!/usr/bin/env bash

set -Eeuo pipefail

readonly DEFAULT_HOST="172.16.0.34"
readonly DEFAULT_SSH_USER="root"
readonly ACCESS_VMID="200"

host=""
ssh_user="$DEFAULT_SSH_USER"
interactive_auth=false

usage() {
    cat <<'EOF'
Usage: ./infra/access/inspect-access-persistence.sh --host 172.16.0.34 [options]

Reads the Proxmox and LXC 200 persistence surfaces needed to plan Access
staging. It does not write files, change interfaces, load rules, or restart
services.

Options:
  --host HOST          Proxmox SSH host (must be 172.16.0.34)
  --ssh-user USER      SSH user (default: root)
  --interactive-auth   Allow SSH password or keyboard-interactive prompts
  --help               Show this help
EOF
}

fail() {
    printf 'Error: %s\n' "$*" >&2
    exit 1
}

while (($#)); do
    case "$1" in
        --host) host="${2:?Missing value for --host}"; shift 2 ;;
        --ssh-user) ssh_user="${2:?Missing value for --ssh-user}"; shift 2 ;;
        --interactive-auth) interactive_auth=true; shift ;;
        --help) usage; exit 0 ;;
        *) fail "Unknown option: $1" ;;
    esac
done

[[ -n "$host" ]] || fail "--host is required"
[[ "$host" == "$DEFAULT_HOST" ]] || fail "Refusing host '$host'; expected $DEFAULT_HOST"
command -v ssh >/dev/null 2>&1 || fail "Required command not found: ssh"

ssh_options=(-o StrictHostKeyChecking=yes)
if [[ "$interactive_auth" == true ]]; then
    ssh_options+=(-o BatchMode=no)
else
    ssh_options+=(-o BatchMode=yes)
fi

ssh "${ssh_options[@]}" "${ssh_user}@${host}" \
    "ACCESS_VMID=$ACCESS_VMID bash -s" <<'REMOTE_SCRIPT'
set -Eeuo pipefail

readonly access_vmid="${ACCESS_VMID:?}"

section() {
    printf '\n[%s]\n' "$1"
}

[[ "$(id -u)" == 0 ]] || {
    printf 'Remote user must be root.\n' >&2
    exit 1
}
command -v pct >/dev/null 2>&1 || {
    printf 'Target is not a Proxmox node with pct.\n' >&2
    exit 1
}
pct status "$access_vmid" | grep -q '^status: running$' || {
    printf 'Access LXC %s is not running.\n' "$access_vmid" >&2
    exit 1
}

section "proxmox container config"
pct config "$access_vmid"

pct exec "$access_vmid" -- sh <<'LXC_SCRIPT'
set -eu

section() {
    printf '\n[%s]\n' "$1"
}

print_file() {
    config_file="$1"
    if [ -f "$config_file" ]; then
        printf '%s\n' "--- $config_file ---"
        sed -n '1,240p' "$config_file" 2>&1 || true
    else
        printf '%s\n' "absent: $config_file"
    fi
}

print_directory() {
    config_directory="$1"
    if [ ! -d "$config_directory" ]; then
        printf '%s\n' "absent: $config_directory"
        return
    fi
    find "$config_directory" -maxdepth 1 -type f -print 2>&1 || true
    for config_file in "$config_directory"/*; do
        [ -f "$config_file" ] || continue
        print_file "$config_file"
    done
}

section "network configuration"
print_file /etc/network/interfaces
print_directory /etc/network/interfaces.d
print_directory /etc/netplan
print_directory /etc/systemd/network

section "generated networkd configuration"
print_directory /run/systemd/network

section "effective links and routes"
ip -br address 2>&1 || true
ip route show table all 2>&1 || true
networkctl list --no-pager 2>&1 || true

section "nftables persistence"
print_file /etc/nftables.conf
print_directory /etc/nftables.d

section "current nftables tables"
nft list tables 2>&1 || true

section "relevant sysctls"
grep -R -n -E 'net\.ipv4\.ip_forward|disable_ipv6' \
    /etc/sysctl.conf /etc/sysctl.d 2>/dev/null || true
sysctl net.ipv4.ip_forward \
    net.ipv6.conf.all.disable_ipv6 \
    net.ipv6.conf.default.disable_ipv6 \
    net.ipv6.conf.lo.disable_ipv6 2>&1 || true

section "service state"
for service_name in networking systemd-networkd NetworkManager nftables; do
    printf '%s: enabled=' "$service_name"
    systemctl is-enabled "$service_name" 2>&1 || true
    printf '%s: active=' "$service_name"
    systemctl is-active "$service_name" 2>&1 || true
done

section "network tooling and packages"
for command_name in netplan networkctl ifreload ifquery nft; do
    command -v "$command_name" 2>&1 || printf 'absent: %s\n' "$command_name"
done
dpkg-query -W -f='${binary:Package}\t${db:Status-Abbrev}\t${Version}\n' \
    netplan.io systemd-resolved ifupdown ifupdown2 nftables 2>&1 || true
LXC_SCRIPT
REMOTE_SCRIPT