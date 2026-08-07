#!/usr/bin/env bash

set -euo pipefail

readonly EXPECTED_HOST="172.16.0.34"
readonly VMID="200"
readonly DEFAULT_INPUT="infra/access/vlan-2000-validation-input.json"
readonly APPLY_CONFIRMATION="STAGE ACCESS 172.16.0.34 LXC 200 VLAN 2000"

host=""
ssh_user="root"
input="$DEFAULT_INPUT"
mode="dry-run"
confirmation=""
transaction=""
interactive_auth=false
rollback_seconds=600

usage() {
    cat <<'EOF'
Usage: ./infra/access/stage-access.sh --host 172.16.0.34 [options]

Stages VLAN 2000 on Access LXC 200 while retaining its management and legacy
addresses. The default is a read-only dry run.

Options:
--host HOST               Proxmox host (must be 172.16.0.34)
--ssh-user USER           SSH user (default: root)
--input FILE              Desired-state input (default: VLAN 2000 fixture)
--interactive-auth        Allow interactive SSH authentication
--rollback-seconds N      Automatic rollback delay, 120-1800 (default: 600)
--dry-run                 Inspect only (default)
--validate                Upload under /run and run target nft -c only
--apply                   Stage and arm automatic rollback
--status TRANSACTION      Inspect a staged transaction without changing it
--commit TRANSACTION      Keep a validated staged transaction
--confirmation TEXT       Required with --apply or --commit
--help                    Show this help

Apply confirmation:
  STAGE ACCESS 172.16.0.34 LXC 200 VLAN 2000
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
        --input) input="${2:?Missing value for --input}"; shift 2 ;;
        --interactive-auth) interactive_auth=true; shift ;;
        --rollback-seconds) rollback_seconds="${2:?Missing value for --rollback-seconds}"; shift 2 ;;
        --dry-run) mode="dry-run"; shift ;;
        --validate) mode="validate"; shift ;;
        --apply) mode="apply"; shift ;;
        --status) mode="status"; transaction="${2:?Missing transaction ID}"; shift 2 ;;
        --commit) mode="commit"; transaction="${2:?Missing transaction ID}"; shift 2 ;;
        --confirmation) confirmation="${2:?Missing value for --confirmation}"; shift 2 ;;
        --help) usage; exit 0 ;;
        *) fail "Unknown option: $1" ;;
    esac
done

[[ "$host" == "$EXPECTED_HOST" ]] || fail "--host must be $EXPECTED_HOST"
[[ "$rollback_seconds" =~ ^[0-9]+$ ]] || fail "--rollback-seconds must be an integer"
((rollback_seconds >= 120 && rollback_seconds <= 1800)) || fail "--rollback-seconds must be between 120 and 1800"
command -v ssh >/dev/null 2>&1 || fail "Required command not found: ssh"
command -v scp >/dev/null 2>&1 || fail "Required command not found: scp"

if [[ "$mode" == apply || "$mode" == commit ]]; then
    [[ "$confirmation" == "$APPLY_CONFIRMATION" ]] || fail "This mode requires --confirmation '$APPLY_CONFIRMATION'"
fi
if [[ "$mode" == commit || "$mode" == status ]]; then
    [[ "$transaction" =~ ^access-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$ ]] || fail "Invalid transaction ID"
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ "$mode" != commit && "$mode" != status ]]; then
    [[ "$input" == /* ]] || input="$repo_root/$input"
    [[ -f "$input" ]] || fail "Input not found: $input"
fi
ssh_options=(-o StrictHostKeyChecking=yes)
if [[ "$interactive_auth" == true ]]; then
    ssh_options+=(-o BatchMode=no)
else
    ssh_options+=(-o BatchMode=yes)
fi

bundle_dir=""
archive=""
remote_archive=""
cleanup() {
    [[ -z "$bundle_dir" ]] || rm -rf "$bundle_dir"
    [[ -z "$archive" ]] || rm -f "$archive"
    if [[ -n "$remote_archive" ]]; then
        ssh "${ssh_options[@]}" "${ssh_user}@${host}" "rm -f '$remote_archive'" >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

revision=""
trunks=""
if [[ "$mode" != commit && "$mode" != status ]]; then
    command -v jq >/dev/null 2>&1 || fail "Required command not found: jq"
    active_count="$(jq '[.groups[] | select(.state == "active")] | length' "$input")"
    [[ "$active_count" == 1 ]] || fail "First staging requires exactly one active group"
    trunks="$(jq -r '.groups[] | select(.state == "active") | .vlan_tag' "$input")"
    [[ "$trunks" == 2000 ]] || fail "First staging is restricted to VLAN 2000"

    bundle_dir="$(mktemp -d)"
    revision="$(cd "$repo_root/backend" && npm run --silent render-access -- "$input" --output-dir "$bundle_dir")"
    [[ "$revision" =~ ^[0-9a-f]{64}$ ]] || fail "Renderer returned an invalid revision"
fi

printf 'Mode: %s\nTarget: %s@%s, LXC %s\n' "$mode" "$ssh_user" "$host" "$VMID"
[[ -z "$revision" ]] || printf 'Revision: %s\nTrunks: %s\n' "$revision" "$trunks"

if [[ "$mode" == apply || "$mode" == validate ]]; then
    archive="$(mktemp)"
    COPYFILE_DISABLE=1 tar -C "$bundle_dir" -czf "$archive" .
    remote_archive="/run/virtual-lab-access-${revision}.tgz"
    scp "${ssh_options[@]}" "$archive" "${ssh_user}@${host}:${remote_archive}"
fi

ssh "${ssh_options[@]}" "${ssh_user}@${host}" \
    "ACCESS_MODE='$mode' ACCESS_VMID='$VMID' ACCESS_REVISION='$revision' ACCESS_TRUNKS='$trunks' ACCESS_ROLLBACK_SECONDS='$rollback_seconds' ACCESS_ARCHIVE='$remote_archive' ACCESS_TRANSACTION='$transaction' bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail

readonly LOCK_FILE=/run/lock/virtual-proxmox-lab-access.lock
readonly STATE_ROOT=/var/lib/virtual-lab-access/transactions
readonly TABLE_NAME=virtual_lab_access
readonly MANAGED_PATHS=(
    /etc/systemd/network/eth1.network.d/50-virtual-lab-vlans.conf
    /etc/systemd/network/50-eth1.2000.netdev
    /etc/systemd/network/50-eth1.2000.network
    /etc/sysctl.d/99-virtual-lab-access.conf
    /etc/nftables.d/virtual-lab-access.nft
)

mode="${ACCESS_MODE:?}"
vmid="${ACCESS_VMID:?}"
revision="${ACCESS_REVISION:-}"
trunks="${ACCESS_TRUNKS:-}"
rollback_seconds="${ACCESS_ROLLBACK_SECONDS:?}"
archive="${ACCESS_ARCHIVE:-}"
transaction="${ACCESS_TRANSACTION:-}"

fail() {
    printf 'Error: %s\n' "$*" >&2
    exit 1
}

for command_name in pct pvesh perl flock systemctl systemd-run sha256sum tar bridge; do
    command -v "$command_name" >/dev/null 2>&1 || fail "Required remote command not found: $command_name"
done
perl -MJSON::PP -e 1 >/dev/null 2>&1 || fail "Required remote Perl module not found: JSON::PP"
[[ "$(id -u)" == 0 ]] || fail "Remote user must be root"
pct status "$vmid" | grep -q 'status: running' || fail "LXC $vmid is not running"

exec 9>"$LOCK_FILE"
flock -n 9 || fail "Another Access operation is running"

current_net1="$(pct config "$vmid" | sed -n 's/^net1: //p')"
host_veth="veth${vmid}i1"
[[ -n "$current_net1" ]] || fail "LXC $vmid has no net1"
[[ "$current_net1" == *name=eth1* && "$current_net1" == *bridge=vmbr20* ]] || fail "net1 is not the approved eth1/vmbr20 transport"
[[ "$current_net1" == *ip=10.10.20.10/24* ]] || fail "net1 no longer retains 10.10.20.10/24"
ip link show "$host_veth" >/dev/null 2>&1 || fail "Running host interface is missing: $host_veth"
pct exec "$vmid" -- ip -4 address show dev eth0 | grep -q '10.10.10.50/24' || fail "Management address is missing"

if [[ "$mode" == status ]]; then
    transaction_dir="$STATE_ROOT/$transaction"
    [[ -d "$transaction_dir" ]] || fail "Transaction does not exist: $transaction"
    if [[ -f "$transaction_dir/ARMED" ]]; then
        state=armed
    elif [[ -f "$transaction_dir/COMMITTED" ]]; then
        state=committed
    elif [[ -f "$transaction_dir/ROLLED_BACK" ]]; then
        state=rolled-back
    else
        state=unknown
    fi
    unit="virtual-lab-access-rollback-${transaction}"
    timer_state="$(systemctl is-active "${unit}.timer" 2>/dev/null || true)"
    [[ -n "$timer_state" ]] || timer_state=not-found
    timer_deadline="$(systemctl show "${unit}.timer" --property=NextElapseUSecRealtime --value 2>/dev/null || true)"
    timer_monotonic="$(systemctl show "${unit}.timer" --property=NextElapseUSecMonotonic --value 2>/dev/null || true)"
    timer_schedule="$(systemctl list-timers --all --no-pager --no-legend "${unit}.timer" 2>/dev/null || true)"
    timer_result="$(systemctl show "${unit}.timer" --property=Result --value 2>/dev/null || true)"
    service_state="$(systemctl is-active "${unit}.service" 2>/dev/null || true)"
    service_result="$(systemctl show "${unit}.service" --property=Result --value 2>/dev/null || true)"
    [[ -n "$timer_deadline" ]] || timer_deadline=unknown
    [[ -n "$timer_monotonic" ]] || timer_monotonic=unknown
    [[ -n "$timer_schedule" ]] || timer_schedule=unknown
    [[ -n "$timer_result" ]] || timer_result=unknown
    [[ -n "$service_state" ]] || service_state=not-found
    [[ -n "$service_result" ]] || service_result=unknown
    printf 'Transaction state: %s\nRollback timer: %s\nRollback deadline: %s\n' "$state" "$timer_state" "$timer_deadline"
    printf 'Rollback monotonic deadline: %s\nRollback schedule: %s\n' "$timer_monotonic" "$timer_schedule"
    printf 'Timer result: %s\nRollback service: %s\nService result: %s\n' "$timer_result" "$service_state" "$service_result"
    printf 'Current net1: %s\n' "$current_net1"
    printf 'Live trunk present: '
    bridge vlan show dev "$host_veth" | awk '$1 == "2000" { found=1 } END { exit !found }' && printf 'yes\n' || printf 'no\n'
    printf 'VLAN address present: '
    pct exec "$vmid" -- ip -4 address show dev eth1.2000 2>/dev/null | grep -q '10.200.0.2/24' && printf 'yes\n' || printf 'no\n'
    printf 'Managed table present: '
    pct exec "$vmid" -- nft list table inet "$TABLE_NAME" >/dev/null 2>&1 && printf 'yes\n' || printf 'no\n'
    for path in "${MANAGED_PATHS[@]}"; do
        pct exec "$vmid" -- test -e "$path" && printf 'present: %s\n' "$path" || printf 'absent: %s\n' "$path"
    done
    exit 0
fi

if [[ "$mode" == commit ]]; then
    transaction_dir="$STATE_ROOT/$transaction"
    [[ -f "$transaction_dir/ARMED" ]] || fail "Transaction is not armed: $transaction"
    expected_revision="$(cat "$transaction_dir/revision")"
    expected_trunks="$(cat "$transaction_dir/trunks")"
    [[ "$current_net1" == *"trunks=$expected_trunks"* ]] || fail "Configured trunks do not match the transaction"
    bridge vlan show dev "$host_veth" | awk -v vlan="$expected_trunks" '$1 == vlan { found=1 } END { exit !found }' || fail "Live host veth is missing VLAN $expected_trunks"
    pct exec "$vmid" -- ip -4 address show dev "eth1.$expected_trunks" | grep -q "10.200.0.2/24" || fail "Staged VLAN address is missing"
    pct exec "$vmid" -- nft list table inet "$TABLE_NAME" | grep -q "Access desired-state revision $expected_revision" || fail "Managed nftables revision is missing"
    unit="virtual-lab-access-rollback-${transaction}"
    systemctl stop "${unit}.timer"
    rm -f "$transaction_dir/ARMED"
    printf '%s\n' "$(date -u +%FT%TZ)" >"$transaction_dir/COMMITTED"
    printf 'Committed transaction %s.\n' "$transaction"
    exit 0
fi

if [[ "$current_net1" == *trunks=* && "$current_net1" != *"trunks=$trunks"* ]]; then
    fail "net1 already has a different trunk allowlist"
fi
candidate_net1="$current_net1"
[[ "$candidate_net1" == *"trunks=$trunks"* ]] || candidate_net1+=",trunks=$trunks"

printf 'Current net1: %s\nCandidate net1: %s\n' "$current_net1" "$candidate_net1"
printf 'Managed table present: '
if pct exec "$vmid" -- nft list table inet "$TABLE_NAME" >/dev/null 2>&1; then
    printf 'yes\n'
    [[ "$mode" == dry-run ]] || fail "Managed nftables table already exists; reconcile or roll it back before staging"
else
    printf 'no\n'
fi
for path in "${MANAGED_PATHS[@]}"; do
    if pct exec "$vmid" -- test -e "$path"; then
        printf 'present: %s\n' "$path"
        [[ "$mode" == dry-run ]] || fail "Managed path already exists: $path"
    else
        printf 'absent: %s\n' "$path"
    fi
done

if [[ "$mode" == dry-run ]]; then
    printf 'PLAN: preserve the exact current net1 and append trunks=%s\n' "$trunks"
    printf 'PLAN: install five revision-marked files without replacing PVE base units\n'
    printf 'PLAN: arm rollback before changing net1, networkd, sysctls, or nftables\n'
    printf 'Dry run complete; no remote resources were changed.\n'
    exit 0
fi

[[ -f "$archive" ]] || fail "Staging archive is missing"
staging_dir="$(mktemp -d /run/virtual-lab-access.XXXXXX)"
trap 'rm -rf "$staging_dir" "$archive"' EXIT
tar -xzf "$archive" -C "$staging_dir"
[[ "$(perl -MJSON::PP -0777 -e 'print decode_json(<>)->{revision} // q{}' "$staging_dir/manifest.json")" == "$revision" ]] || fail "Manifest revision mismatch"
while IFS=$'\t' read -r path expected_hash; do
    [[ "$path" == /* && "$path" != *..* ]] || fail "Unsafe manifest path: $path"
    source="$staging_dir/rootfs${path}"
    [[ -f "$source" ]] || fail "Manifest file is missing: $path"
    [[ "$(sha256sum "$source" | awk '{print $1}')" == "$expected_hash" ]] || fail "Hash mismatch: $path"
done < <(perl -MJSON::PP -0777 -e '$files = decode_json(<>)->{files}; print "$_\t$files->{$_}\n" for sort keys %$files' "$staging_dir/manifest.json")
[[ "$(perl -MJSON::PP -0777 -e '$files = decode_json(<>)->{files}; print scalar keys %$files' "$staging_dir/manifest.json")" == "${#MANAGED_PATHS[@]}" ]] || fail "Unexpected manifest file count"

candidate_root="/run/virtual-lab-access-candidate-$revision"
pct exec "$vmid" -- rm -rf "$candidate_root"
pct exec "$vmid" -- mkdir -p "$candidate_root"
for path in "${MANAGED_PATHS[@]}"; do
    source="$staging_dir/rootfs${path}"
    candidate="$candidate_root${path}"
    pct exec "$vmid" -- mkdir -p "$(dirname "$candidate")"
    pct push "$vmid" "$source" "$candidate" --perms 0644
done
pct exec "$vmid" -- nft -c -f "$candidate_root/etc/nftables.d/virtual-lab-access.nft"
grep -q '^net.ipv4.ip_forward = 1$' "$staging_dir/rootfs/etc/sysctl.d/99-virtual-lab-access.conf" || fail "Invalid sysctl candidate"
if [[ "$mode" == validate ]]; then
    pct exec "$vmid" -- rm -rf "$candidate_root"
    printf 'Target validation complete; no persistent or runtime configuration was changed.\n'
    exit 0
fi

mkdir -p "$STATE_ROOT"
transaction="access-$(date -u +%Y%m%dT%H%M%SZ)-${revision:0:12}"
transaction_dir="$STATE_ROOT/$transaction"
mkdir "$transaction_dir"
printf '%s\n' "$current_net1" >"$transaction_dir/net1.before"
printf '%s\n' "$revision" >"$transaction_dir/revision"
printf '%s\n' "$trunks" >"$transaction_dir/trunks"
for key in \
    net.ipv4.ip_forward \
    net.ipv6.conf.all.disable_ipv6 \
    net.ipv6.conf.default.disable_ipv6 \
    net.ipv6.conf.lo.disable_ipv6; do
    printf '%s=%s\n' "$key" "$(pct exec "$vmid" -- sysctl -n "$key")" >>"$transaction_dir/sysctl.before"
done

cat >"$transaction_dir/rollback.sh" <<'ROLLBACK_SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
readonly LOCK_FILE=/run/lock/virtual-proxmox-lab-access.lock
readonly TABLE_NAME=virtual_lab_access
readonly MANAGED_PATHS=(
    /etc/systemd/network/eth1.network.d/50-virtual-lab-vlans.conf
    /etc/systemd/network/50-eth1.2000.netdev
    /etc/systemd/network/50-eth1.2000.network
    /etc/sysctl.d/99-virtual-lab-access.conf
    /etc/nftables.d/virtual-lab-access.nft
)
transaction_dir="${1:?Missing transaction directory}"
vmid="${2:?Missing VMID}"
exec 9>"$LOCK_FILE"
flock 9
net1="$(cat "$transaction_dir/net1.before")"
pct set "$vmid" --net1 "$net1"
if [[ "$net1" != *trunks=2000* ]]; then
    bridge vlan del dev "veth${vmid}i1" vid 2000 >/dev/null 2>&1 || true
fi
pct exec "$vmid" -- nft delete table inet "$TABLE_NAME" >/dev/null 2>&1 || true
for path in "${MANAGED_PATHS[@]}"; do
    pct exec "$vmid" -- rm -f "$path"
done
pct exec "$vmid" -- networkctl reload
pct exec "$vmid" -- networkctl reconfigure eth1
if pct exec "$vmid" -- ip link show eth1.2000 >/dev/null 2>&1; then
    pct exec "$vmid" -- ip link delete eth1.2000
fi
while IFS= read -r setting; do
    pct exec "$vmid" -- sysctl -w "$setting"
done <"$transaction_dir/sysctl.before"
rm -f "$transaction_dir/ARMED"
printf '%s\n' "$(date -u +%FT%TZ)" >"$transaction_dir/ROLLED_BACK"
ROLLBACK_SCRIPT
chmod 0700 "$transaction_dir/rollback.sh"
touch "$transaction_dir/ARMED"

unit="virtual-lab-access-rollback-${transaction}"
systemd-run --unit="$unit" --on-active="${rollback_seconds}s" \
    "$transaction_dir/rollback.sh" "$transaction_dir" "$vmid" >/dev/null

node="$(pvesh get /cluster/resources --type vm --output-format json | perl -MJSON::PP -e '$target = shift; $resources = decode_json(do { local $/; <STDIN> }); print $_->{node} for grep { $_->{vmid} == $target } @$resources' "$vmid")"
[[ -n "$node" && "$node" != null ]] || fail "Cannot resolve LXC node"
digest="$(pvesh get "/nodes/$node/lxc/$vmid/config" --output-format json | perl -MJSON::PP -0777 -e 'print decode_json(<STDIN>)->{digest} // q{}')"
[[ "$digest" =~ ^[0-9a-f]{40}$ ]] || fail "Cannot resolve LXC config digest"
pct set "$vmid" --net1 "$candidate_net1" --digest "$digest"
bridge vlan add dev "$host_veth" vid "$trunks"
bridge vlan show dev "$host_veth" | awk -v vlan="$trunks" '$1 == vlan { found=1 } END { exit !found }' || fail "Failed to add VLAN $trunks to live host veth; rollback remains armed"

for path in "${MANAGED_PATHS[@]}"; do
    pct exec "$vmid" -- mkdir -p "$(dirname "$path")"
    pct push "$vmid" "$staging_dir/rootfs${path}" "$path" --perms 0644
done
pct exec "$vmid" -- networkctl reload
pct exec "$vmid" -- networkctl reconfigure eth1
pct exec "$vmid" -- sysctl -p /etc/sysctl.d/99-virtual-lab-access.conf
pct exec "$vmid" -- nft -f /etc/nftables.d/virtual-lab-access.nft

pct exec "$vmid" -- ip -4 address show dev eth0 | grep -q '10.10.10.50/24' || fail "Management address was lost; rollback remains armed"
pct exec "$vmid" -- ip -4 address show dev eth1 | grep -q '10.10.20.10/24' || fail "Legacy address was lost; rollback remains armed"
pct exec "$vmid" -- ip -4 address show dev eth1.2000 | grep -q '10.200.0.2/24' || fail "VLAN 2000 address is missing; rollback remains armed"
pct exec "$vmid" -- nft list table inet "$TABLE_NAME" | grep -q "Access desired-state revision $revision" || fail "Managed nftables revision is missing; rollback remains armed"

printf 'Staged transaction: %s\n' "$transaction"
printf 'Automatic rollback: %s seconds\n' "$rollback_seconds"
printf 'After acceptance tests, commit with --commit %s and the same confirmation.\n' "$transaction"
REMOTE_SCRIPT