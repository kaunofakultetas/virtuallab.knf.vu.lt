#!/usr/bin/env bash

set -euo pipefail

readonly DEFAULT_HOST="172.16.0.34"
readonly DEFAULT_SSH_USER="root"
readonly CONFIRMATION="APPLY NETWORK 172.16.0.34 vmbr1 vmbr20"

host=""
ssh_user="$DEFAULT_SSH_USER"
apply=false
confirmation=""
forward_app_ports=false
interactive_auth=false
replace_drifted_files=false

usage() {
    cat <<'EOF'
Usage: ./scripts/setup-proxmox-host-network.sh --host 172.16.0.34 [options]

Reconciles the host networking required by the OpenTofu-managed LXCs. The
default is a non-mutating dry run.

Options:
  --host HOST          Proxmox SSH host (must be 172.16.0.34)
  --ssh-user USER      SSH user (default: root)
    --interactive-auth   Allow SSH password or keyboard-interactive prompts
  --forward-app-ports  Forward TCP 80/443/8888 and UDP 443 to 10.10.10.100
    --replace-drifted-files
                                             Replace changed files already marked as script-managed
  --dry-run            Inspect and print planned actions (default)
  --apply              Apply the managed configuration
  --confirmation TEXT  Required with --apply
  --help               Show this help

Apply confirmation:
  APPLY NETWORK 172.16.0.34 vmbr1 vmbr20
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
[[ "$host" == "$DEFAULT_HOST" ]] || fail "Refusing host '$host'; expected $DEFAULT_HOST"
command -v ssh >/dev/null 2>&1 || fail "Required command not found: ssh"

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
readonly NETWORK_FILE=/etc/network/interfaces.d/virtual-proxmox-lab
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

for command_name in pveversion ip flock grep awk diff; do
    command -v "$command_name" >/dev/null 2>&1 || fail "Required remote command not found: $command_name"
done
[[ "$(id -u)" == 0 ]] || fail "Remote user must be root"
pveversion >/dev/null || fail "Target is not a working Proxmox VE node"

exec 9>"$LOCK_FILE"
flock -n 9 || fail "Another virtual-proxmox-lab host operation is running"

uplink="$(ip route show default | awk '/default/ { print $5; exit }')"
[[ -n "$uplink" ]] || fail "Could not identify the default-route interface"
[[ "$uplink" != vmbr1 && "$uplink" != vmbr20 ]] || fail "Default route unexpectedly uses a managed bridge"

for bridge in vmbr1 vmbr20; do
    foreign_refs="$(grep -Rsl -E "^(auto[[:space:]]+.*[[:space:]])?${bridge}([[:space:]]|$)|^iface[[:space:]]+${bridge}[[:space:]]" \
        /etc/network/interfaces /etc/network/interfaces.d 2>/dev/null || true)"
    if [[ -n "$foreign_refs" && "$foreign_refs" != "$NETWORK_FILE" ]]; then
        fail "$bridge is already defined outside $NETWORK_FILE: $foreign_refs"
    fi
done

if [[ -e "$NFT_FILE" ]] && ! grep -q '^# Managed by setup-proxmox-host-network.sh$' "$NFT_FILE"; then
    fail "Refusing unmarked nftables file $NFT_FILE"
fi
if nft list table ip virtual_lab_host_network >/dev/null 2>&1 && [[ ! -e "$NFT_FILE" ]]; then
    fail "nftables table virtual_lab_host_network exists without its managed file"
fi

network_content='# Managed by setup-proxmox-host-network.sh
auto vmbr1
iface vmbr1 inet static
    address 10.10.10.1/24
    bridge-ports none
    bridge-stp off
    bridge-fd 0

auto vmbr20
iface vmbr20 inet static
    address 10.10.20.1/24
    bridge-ports none
    bridge-stp off
    bridge-fd 0'

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
    "$NETWORK_FILE|$network_content" \
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
plan "install or retain managed bridge, DHCP, nftables, and forwarding files"
plan "validate candidates before activating vmbr1 and vmbr20"
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

install -d -m 0755 /etc/network/interfaces.d /etc/dnsmasq.d /etc/nftables.d
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
printf '%s\n' "$network_content" >"$tmp_dir/network"
printf '%s\n' "$dnsmasq_content" >"$tmp_dir/dnsmasq"
printf '%s\n' "$nft_content" >"$tmp_dir/nftables"
printf '%s\n' "$sysctl_content" >"$tmp_dir/sysctl"

nft -c -f "$tmp_dir/nftables"
dnsmasq --test --conf-file="$tmp_dir/dnsmasq"

install -m 0644 "$tmp_dir/network" "$NETWORK_FILE"
install -m 0644 "$tmp_dir/dnsmasq" "$DNSMASQ_FILE"
install -m 0644 "$tmp_dir/nftables" "$NFT_FILE"
install -m 0644 "$tmp_dir/sysctl" "$SYSCTL_FILE"

if ! grep -qF "$NFT_INCLUDE" /etc/nftables.conf; then
    printf '\n%s\n' "$NFT_INCLUDE" >>/etc/nftables.conf
fi

ifreload -a -n
ifreload -a
dnsmasq --test
systemctl enable dnsmasq nftables
systemctl restart dnsmasq
systemctl start nftables
nft delete table ip virtual_lab_host_network 2>/dev/null || true
nft -f "$NFT_FILE"
sysctl --system >/dev/null

[[ "$(sysctl -n net.ipv4.ip_forward)" == 1 ]] || fail "IPv4 forwarding is not enabled"
ip -br address show vmbr1
ip -br address show vmbr20
nft list table ip virtual_lab_host_network
printf 'Host network reconciliation complete.\n'
REMOTE_SCRIPT