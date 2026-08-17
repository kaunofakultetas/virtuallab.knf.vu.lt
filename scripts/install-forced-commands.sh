#!/usr/bin/env bash

set -euo pipefail

# The forced commands are the contract boundary between the orchestrator and the
# Proxmox host: they run as root behind restricted SSH keys, and the host holds a
# *copy* rather than a checkout. Nothing else in this repository updates that
# copy, so a change to infra/access or infra/gateway is inert until it is pushed
# here — and a stale copy is a contract drifting silently, which is exactly the
# failure this script exists to make visible.

readonly DEFAULT_SSH_USER="root"
readonly REMOTE_DIR="/usr/local/libexec/virtual-lab"
readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

host=""
ssh_user="$DEFAULT_SSH_USER"
apply=false
interactive_auth=false

usage() {
    cat <<'EOF'
Usage: ./scripts/install-forced-commands.sh --host <address> [options]

Installs the SSH forced commands onto a Proxmox host and verifies that what
landed matches this checkout byte for byte. The default is a non-mutating dry
run that reports drift.

Run this after ANY change to infra/access/*.py or infra/gateway/*.py. The host
holds a copy, so an unpushed change is inert, and a stale copy fails in ways
that look like network faults rather than version skew.

Options:
  --host HOST         Proxmox SSH host, e.g. 172.16.0.34 (development)
                      or 172.16.0.122 (production)
  --ssh-user USER     SSH user (default: root)
  --interactive-auth  Allow SSH password or keyboard-interactive prompts
  --dry-run           Compare only, report drift, change nothing (default)
  --apply             Install files that differ, then re-verify
  --help              Show this help

No confirmation phrase is required: this only replaces files with the contents
of the current checkout, and re-running it is idempotent.
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
        --dry-run) apply=false; shift ;;
        --apply) apply=true; shift ;;
        --help) usage; exit 0 ;;
        *) usage >&2; fail "Unknown argument: $1" ;;
    esac
done

[[ -n "$host" ]] || { usage >&2; fail "--host is required"; }

ssh_options=(-o StrictHostKeyChecking=accept-new)
if [[ "$interactive_auth" == false ]]; then
    ssh_options+=(-o BatchMode=yes)
fi

remote() { ssh "${ssh_options[@]}" "${ssh_user}@${host}" "$@"; }

# Enumerated rather than globbed. A glob would silently start shipping any new
# file dropped into these directories, including tests and fixtures, and these
# run as root.
readonly SOURCES=(
    "infra/access/apply_access.py"
    "infra/access/apply_access_forced_command.py"
    "infra/access/apply_access_trunk_forced_command.py"
    "infra/access/observe_access.py"
    "infra/access/observe_access_forced_command.py"
    "infra/gateway/apply_gateway.py"
    "infra/gateway/apply_gateway_forced_command.py"
    "infra/gateway/observe_gateway.py"
    "infra/gateway/observe_gateway_forced_command.py"
)

for relative in "${SOURCES[@]}"; do
    [[ -f "${REPO_ROOT}/${relative}" ]] || fail "missing from checkout: ${relative}"
done

printf 'Forced commands: %s\n' "$([[ "$apply" == true ]] && echo apply || echo dry-run)"
printf 'Target: %s@%s:%s\n' "$ssh_user" "$host" "$REMOTE_DIR"

remote_sums="$(remote "cat ${REMOTE_DIR}/*.py 2>/dev/null | true; sha256sum ${REMOTE_DIR}/*.py 2>/dev/null || true")"

drifted=()
for relative in "${SOURCES[@]}"; do
    name="$(basename "$relative")"
    local_sum="$(sha256sum "${REPO_ROOT}/${relative}" | cut -d' ' -f1)"
    remote_sum="$(printf '%s\n' "$remote_sums" | awk -v p="${REMOTE_DIR}/${name}" '$2 == p {print $1}')"
    if [[ -z "$remote_sum" ]]; then
        printf 'missing: %s\n' "$name"
        drifted+=("$relative")
    elif [[ "$remote_sum" != "$local_sum" ]]; then
        printf 'drifted: %s\n' "$name"
        drifted+=("$relative")
    else
        printf 'matching: %s\n' "$name"
    fi
done

if ((${#drifted[@]} == 0)); then
    printf 'All %d forced commands match this checkout.\n' "${#SOURCES[@]}"
    exit 0
fi

if [[ "$apply" == false ]]; then
    printf '\n%d file(s) would be installed. Re-run with --apply.\n' "${#drifted[@]}"
    exit 1
fi

remote "install -d -m 0755 ${REMOTE_DIR}"
for relative in "${drifted[@]}"; do
    name="$(basename "$relative")"
    # Written to a temporary name and moved into place, so a forced command
    # invoked mid-copy never executes a half-written file.
    scp "${ssh_options[@]}" -q "${REPO_ROOT}/${relative}" "${ssh_user}@${host}:${REMOTE_DIR}/.${name}.incoming"
    remote "chmod 0755 ${REMOTE_DIR}/.${name}.incoming && mv -f ${REMOTE_DIR}/.${name}.incoming ${REMOTE_DIR}/${name}"
    printf 'installed: %s\n' "$name"
done

failures=0
verify_sums="$(remote "sha256sum ${REMOTE_DIR}/*.py")"
for relative in "${SOURCES[@]}"; do
    name="$(basename "$relative")"
    local_sum="$(sha256sum "${REPO_ROOT}/${relative}" | cut -d' ' -f1)"
    remote_sum="$(printf '%s\n' "$verify_sums" | awk -v p="${REMOTE_DIR}/${name}" '$2 == p {print $1}')"
    [[ "$remote_sum" == "$local_sum" ]] || { printf 'VERIFY FAILED: %s\n' "$name"; failures=$((failures + 1)); }
done

((failures == 0)) || fail "${failures} file(s) do not match after installation"

printf 'Installed and verified %d file(s); all %d match this checkout.\n' "${#drifted[@]}" "${#SOURCES[@]}"
