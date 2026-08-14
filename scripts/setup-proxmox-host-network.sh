#!/usr/bin/env bash

set -euo pipefail

readonly DEFAULT_SSH_USER="root"
# The confirmation phrase carries the target host, so a phrase copied from a
# previous run cannot apply to a different box. There is exactly one guard
# against reconfiguring production while meaning to reconfigure development,
# and this is it.
confirmation_phrase() { printf 'APPLY NETWORK %s vmbr1 vmbr20' "$1"; }

host=""
ssh_user="$DEFAULT_SSH_USER"
apply=false
confirmation=""
forward_app_ports=false
interactive_auth=false
replace_drifted_files=false

usage() {
    cat <<'EOF'
Usage: ./scripts/setup-proxmox-host-network.sh --host <address> [options]

Reconciles the host DHCP, NAT, and forwarding required by the OpenTofu-managed
LXCs. The default is a non-mutating dry run.

Bridges are NOT created here. Proxmox owns vmbr1 and vmbr20 in
/etc/network/interfaces, because PVE does not read its network configuration
from sourced files and a bridge under interfaces.d is invisible to its API and
to backend readiness. This script only verifies that they exist and is safe to
run while guests are attached: it reloads no interface.

Options:
  --host HOST          Proxmox SSH host, e.g. 172.16.0.34 (development)
                       or 172.16.0.122 (production)
  --ssh-user USER      SSH user (default: root)
    --interactive-auth   Allow SSH password or keyboard-interactive prompts
  --forward-app-ports  Forward TCP 80/443/8888 and UDP 443 to 10.10.10.100
    --replace-drifted-files
                                             Replace changed files already marked as script-managed
  --dry-run            Inspect and print planned actions (default)
  --apply              Apply the managed configuration
  --confirmation TEXT  Required with --apply
  --help               Show this help

Apply confirmation, which names the host so a phrase cannot be reused against
a different one:
  APPLY NETWORK <host> vmbr1 vmbr20
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
        --forward-app-ports) forward_app_ports=true; shift ;;
        --replace-drifted-files) replace_drifted_files=true; shift ;;
        --dry-run) apply=false; shift ;;
        --apply) apply=true; shift ;;
        --confirmation) confirmation="${2:?Missing value for --confirmation}"; shift 2 ;;
        --help) usage; exit 0 ;;
        *) fail "Unknown option: $1" ;;
    esac
done

[[ -n "$host" ]] || fail "--host is required"
[[ "$host" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || fail "Refusing host '$host'; expected an address or hostname"
command -v ssh >/dev/null 2>&1 || fail "Required command not found: ssh"

readonly CONFIRMATION="$(confirmation_phrase "$host")"

if [[ "$apply" == true ]]; then
    [[ "$confirmation" == "$CONFIRMATION" ]] || fail "--apply requires --confirmation '$CONFIRMATION'"
elif [[ "$replace_drifted_files" == true ]]; then
    fail "--replace-drifted-files requires --apply"
fi

printf 'Host network mode: %s\nTarget: %s@%s\nPublic ingress: %s\n' \
    "$([[ "$apply" == true ]] && printf apply || printf dry-run)" \
    "$ssh_user" "$host" "$forward_app_ports"

ssh_options=(-o StrictHostKeyChecking=yes)
if [[ "$interactive_auth" == true ]]; then
    ssh_options+=(-o BatchMode=no)
else
    ssh_options+=(-o BatchMode=yes)
fi

ssh "${ssh_options[@]}" "${ssh_user}@${host}" \
    "NETWORK_APPLY=$([[ "$apply" == true ]] && printf 1 || printf 0) FORWARD_APP_PORTS=$forward_app_ports REPLACE_DRIFTED_FILES=$replace_drifted_files bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail

readonly LOCK_FILE=/run/lock/virtual-proxmox-lab-host.lock
# Bridges are owned by Proxmox itself, in /etc/network/interfaces. PVE does not
# read its network configuration from sourced files, so a bridge defined under
# interfaces.d is invisible to the API and to readiness. This path is retained
# only so a stale file from the previous ownership model is detected.
readonly LEGACY_NETWORK_FILE=/etc/network/interfaces.d/virtual-proxmox-lab
readonly PVE_NETWORK_FILE=/etc/network/interfaces
readonly DNSMASQ_FILE=/etc/dnsmasq.d/virtual-proxmox-lab.conf
readonly NFT_FILE=/etc/nftables.d/virtual-proxmox-lab-host-network.nft
readonly SYSCTL_FILE=/etc/sysctl.d/99-virtual-proxmox-lab-host-network.conf
readonly NFT_INCLUDE='include "/etc/nftables.d/*.nft"'

apply="${NETWORK_APPLY:-0}"
forward_app_ports="${FORWARD_APP_PORTS:-false}"
replace_drifted_files="${REPLACE_DRIFTED_FILES:-false}"

fail() {
    printf 'Error: %s\n' "$*" >&2
    exit 1
}

plan() {
    printf 'PLAN: %s\n' "$*"
}

for command_name in pveversion ip bridge flock grep awk diff; do
    command -v "$command_name" >/dev/null 2>&1 || fail "Required remote command not found: $command_name"
done
[[ "$(id -u)" == 0 ]] || fail "Remote user must be root"
pveversion >/dev/null || fail "Target is not a working Proxmox VE node"

exec 9>"$LOCK_FILE"
flock -n 9 || fail "Another virtual-proxmox-lab host operation is running"

uplink="$(ip route show default | awk '/default/ { print $5; exit }')"
[[ -n "$uplink" ]] || fail "Could not identify the default-route interface"
[[ "$uplink" != vmbr1 && "$uplink" != vmbr20 ]] || fail "Default route unexpectedly uses a managed bridge"

if [[ -e "$LEGACY_NETWORK_FILE" ]]; then
    fail "$LEGACY_NETWORK_FILE still defines lab bridges. Proxmox now owns them in
$PVE_NETWORK_FILE; a duplicate definition would be applied twice. Remove the
legacy file, confirm the bridges exist in the Proxmox network configuration,
then rerun."
fi

# Proxmox must own each lab bridge, otherwise its API cannot report it and the
# backend's transport-bridge readiness check can never pass.
for bridge in vmbr1 vmbr20; do
    grep -qE "^iface[[:space:]]+${bridge}[[:space:]]" "$PVE_NETWORK_FILE" || \
        fail "$bridge is not defined in $PVE_NETWORK_FILE; create it through the Proxmox API, for example: pvesh create /nodes/\$(hostname)/network --iface $bridge --type bridge --cidr <addr>/24 --autostart 1"
    [[ -e "/sys/class/net/${bridge}" ]] || fail "$bridge is defined but not present"
done

if [[ -e "$NFT_FILE" ]] && ! grep -q '^# Managed by setup-proxmox-host-network.sh$' "$NFT_FILE"; then
    fail "Refusing unmarked nftables file $NFT_FILE"
fi
if nft list table ip virtual_lab_host_network >/dev/null 2>&1 && [[ ! -e "$NFT_FILE" ]]; then
    fail "nftables table virtual_lab_host_network exists without its managed file"
fi

dnsmasq_content='# Managed by setup-proxmox-host-network.sh
interface=vmbr1
interface=vmbr20
bind-dynamic
dhcp-authoritative
dhcp-range=vmbr1,10.10.10.120,10.10.10.199,255.255.255.0,12h
dhcp-option=vmbr1,option:router,10.10.10.1
dhcp-option=vmbr1,option:dns-server,1.1.1.1,8.8.8.8
dhcp-range=vmbr20,10.10.20.120,10.10.20.199,255.255.255.0,12h
dhcp-option=vmbr20,option:router,10.10.20.1
dhcp-option=vmbr20,option:dns-server,1.1.1.1,8.8.8.8'

nft_content="# Managed by setup-proxmox-host-network.sh
table ip virtual_lab_host_network {
    chain prerouting {
        type nat hook prerouting priority dstnat; policy accept;"

if [[ "$forward_app_ports" == true ]]; then
    nft_content+="
        iifname \"${uplink}\" tcp dport { 80, 443, 8888 } dnat to 10.10.10.100
        iifname \"${uplink}\" udp dport 443 dnat to 10.10.10.100"
fi

nft_content+="
    }

    chain postrouting {
        type nat hook postrouting priority srcnat; policy accept;
        ip saddr { 10.10.10.0/24, 10.10.20.0/24 } oifname \"${uplink}\" masquerade
    }

    chain forward {
        type filter hook forward priority filter; policy accept;
        iifname { \"vmbr1\", \"vmbr20\" } oifname \"${uplink}\" accept
        iifname \"${uplink}\" oifname { \"vmbr1\", \"vmbr20\" } ct state established,related accept"

if [[ "$forward_app_ports" == true ]]; then
    nft_content+=$'\n        ip daddr 10.10.10.100 tcp dport { 80, 443, 8888 } accept\n        ip daddr 10.10.10.100 udp dport 443 accept'
fi

nft_content+=$'\n    }\n}'
sysctl_content='# Managed by setup-proxmox-host-network.sh
net.ipv4.ip_forward = 1'

classify_file() {
    local path="$1"
    local expected="$2"
    if [[ ! -e "$path" ]]; then
        printf 'absent'
    elif [[ "$(cat "$path")" == "$expected" ]]; then
        printf 'matching'
    else
        printf 'drifted'
    fi
}

for entry in \
    "$DNSMASQ_FILE|$dnsmasq_content" \
    "$NFT_FILE|$nft_content" \
    "$SYSCTL_FILE|$sysctl_content"; do
    path="${entry%%|*}"
    content="${entry#*|}"
    classification="$(classify_file "$path" "$content")"
    printf '%s: %s\n' "$classification" "$path"
    if [[ "$classification" == drifted ]]; then
        diff -u "$path" <(printf '%s\n' "$content") || true
        [[ "$replace_drifted_files" == true ]] || fail "Managed file has drifted: $path (review it, then rerun --apply with --replace-drifted-files)"
        plan "replace drifted managed file $path"
    fi
done

plan "install missing dnsmasq, nftables, and ifupdown2 packages"
plan "install or retain managed DHCP, nftables, and forwarding files"
plan "validate candidates before activating them"
plan "verify Proxmox-owned vmbr1 and VLAN-aware vmbr20 without reconfiguring them"
printf 'Network contract: LXC 200 -> 10.10.10.50/24 and 10.10.20.10/24; LXC 201 -> 10.10.10.100/24\n'

if [[ "$apply" != 1 ]]; then
    printf 'Dry run complete; no remote resources were changed.\n'
    exit 0
fi

missing_packages=()
for package_name in dnsmasq nftables ifupdown2; do
    dpkg-query -W -f='${Status}' "$package_name" 2>/dev/null | grep -q 'ok installed' || missing_packages+=("$package_name")
done
if ((${#missing_packages[@]})); then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing_packages[@]}"
fi

grep -qE '^[[:space:]]*(source|source-directory)[[:space:]]+/etc/network/interfaces\.d' /etc/network/interfaces || \
    fail "/etc/network/interfaces does not source /etc/network/interfaces.d"

install -d -m 0755 /etc/dnsmasq.d /etc/nftables.d
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
printf '%s\n' "$dnsmasq_content" >"$tmp_dir/dnsmasq"
printf '%s\n' "$nft_content" >"$tmp_dir/nftables"
printf '%s\n' "$sysctl_content" >"$tmp_dir/sysctl"

nft -c -f "$tmp_dir/nftables"
dnsmasq --test --conf-file="$tmp_dir/dnsmasq"

install -m 0644 "$tmp_dir/dnsmasq" "$DNSMASQ_FILE"
install -m 0644 "$tmp_dir/nftables" "$NFT_FILE"
install -m 0644 "$tmp_dir/sysctl" "$SYSCTL_FILE"

if ! grep -qF "$NFT_INCLUDE" /etc/nftables.conf; then
    printf '\n%s\n' "$NFT_INCLUDE" >>/etc/nftables.conf
fi

# No ifreload: this script no longer defines any interface, and reloading would
# needlessly disturb bridges that Proxmox owns and that carry running guests.
dnsmasq --test
systemctl enable dnsmasq nftables
systemctl restart dnsmasq
systemctl start nftables
nft delete table ip virtual_lab_host_network 2>/dev/null || true
nft -f "$NFT_FILE"
sysctl --system >/dev/null

[[ "$(sysctl -n net.ipv4.ip_forward)" == 1 ]] || fail "IPv4 forwarding is not enabled"
[[ -e /sys/class/net/vmbr20/bridge/vlan_filtering ]] || fail "vmbr20 is not a Linux bridge"
[[ "$(cat /sys/class/net/vmbr20/bridge/vlan_filtering)" == 1 ]] || fail "vmbr20 VLAN filtering is not enabled"
ifquery vmbr20 | grep -Eq '^[[:space:]]*bridge-vids[[:space:]]+2000-2255([[:space:]]|$)' || \
    fail "vmbr20 effective configuration does not allow VLANs 2000-2255"
ip -br address show vmbr1
ip -br address show vmbr20
bridge vlan show dev vmbr20
nft list table ip virtual_lab_host_network
printf 'Host network reconciliation complete.\n'
REMOTE_SCRIPT