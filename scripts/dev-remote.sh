#!/usr/bin/env bash

set -Eeuo pipefail

# Fixed entry point for the development Proxmox host operations that the
# network-architecture work needs to repeat. Each subcommand is a single,
# reviewable remote action so it can be granted narrowly instead of allowing
# arbitrary remote shell access.

readonly DEFAULT_HOST="172.16.0.34"
readonly DEFAULT_CTID="201"
readonly DEFAULT_INSTALL_ROOT="/srv/virtual-proxmox-lab"

readonly HOST="${DEV_REMOTE_HOST:-$DEFAULT_HOST}"
readonly CTID="${DEV_REMOTE_CTID:-$DEFAULT_CTID}"
readonly INSTALL_ROOT="${DEV_REMOTE_INSTALL_ROOT:-$DEFAULT_INSTALL_ROOT}"

usage() {
    cat <<'EOF'
Usage:
  ./scripts/dev-remote.sh <command>

Commands:
  deploy            Run runUpdateThisStack.sh --allow-dirty inside the API LXC.
  preflight-tokens  Run the secret-safe Proxmox network token lifecycle preflight.
  attempt-status    Print the newest reconciliation attempt summary.
  attempt-detail    Print the newest attempt's revision, actions, and checks.
  configure-gateway <mgmt> <trunk> <uplink> <resolvers>
                    Record the Gateway guest interface names and resolvers.
  settings          List persisted settings (metadata) keys and values.
  groups            List persisted network groups and their allocations.
  vnets             List Proxmox SDN VNets and zones.
  status            Print Compose service state.

Environment overrides:
  DEV_REMOTE_HOST          Proxmox host (default: 172.16.0.34)
  DEV_REMOTE_CTID          API LXC id (default: 201)
  DEV_REMOTE_INSTALL_ROOT  Checkout path (default: /srv/virtual-proxmox-lab)

No command prints secrets, .env contents, or token values.
EOF
}

fail() {
    printf 'Error: %s\n' "$*" >&2
    exit 1
}

# Runs a command on the Proxmox host itself.
on_host() {
    ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30 \
        "root@${HOST}" "$@"
}

# Runs a shell snippet inside the API LXC, rooted at the checkout.
in_ct() {
    on_host "pct exec ${CTID} -- sh -c 'cd ${INSTALL_ROOT} && $1'"
}

cmd_deploy() {
    in_ct "./runUpdateThisStack.sh --allow-dirty"
}

cmd_preflight_tokens() {
    in_ct "docker compose exec -T virtual-lab-backend npm run preflight-network-tokens"
}

cmd_attempt_status() {
    in_ct "docker compose exec -T virtual-lab-postgres sh -c '\''psql -x -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -c \"SELECT id, mode, status, phase, applied_revision, error_code, created_at FROM network_reconciliation_attempts ORDER BY id DESC LIMIT 1\"'\''"
}

# Prints the newest attempt's desired revision, planned actions, and checks, so
# an apply decision can be reviewed before it is made. The SQL deliberately
# contains no single quotes, which keeps the nested shell quoting readable.
cmd_attempt_detail() {
    in_ct "docker compose exec -T virtual-lab-postgres sh -c '\''psql -x -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -c \"SELECT id, desired_revision, jsonb_array_length(checks) AS n_checks, jsonb_array_length(actions) AS n_actions FROM network_reconciliation_attempts ORDER BY id DESC LIMIT 1\" -c \"SELECT jsonb_pretty(actions) AS actions FROM network_reconciliation_attempts ORDER BY id DESC LIMIT 1\" -c \"SELECT jsonb_pretty(checks) AS checks FROM network_reconciliation_attempts ORDER BY id DESC LIMIT 1\"'\''"
}

# Records the Gateway guest's observed interface names and upstream resolvers.
# Values are passed as environment variables so no shell quoting reaches the SQL
# or JavaScript layer.
cmd_configure_gateway() {
    local management="${1:?management interface required}"
    local trunk="${2:?trunk interface required}"
    local uplink="${3:?uplink interface required}"
    local resolvers="${4:?comma-separated resolvers required}"
    in_ct "docker compose exec -T \
        -e GATEWAY_MANAGEMENT_INTERFACE=${management} \
        -e GATEWAY_TRUNK_INTERFACE=${trunk} \
        -e GATEWAY_UPLINK_INTERFACE=${uplink} \
        -e GATEWAY_UPSTREAM_RESOLVERS=${resolvers} \
        virtual-lab-backend npm run --silent set-gateway-settings"
}

# Lists every setting. The SQL carries no single quotes on purpose; filter the
# output locally rather than complicating the nested shell quoting.
cmd_settings() {
    in_ct "docker compose exec -T virtual-lab-postgres sh -c '\''psql -Atq -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -c \"SELECT key, value FROM metadata ORDER BY key\"'\''"
}

cmd_groups() {
    in_ct "docker compose exec -T virtual-lab-postgres sh -c '\''psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -c \"SELECT id, owner_id, profile_id, vlan_tag, vnet_name, subnet_cidr, state FROM network_groups ORDER BY id\"'\''"
}

# Authenticated read-only readiness report, minted with a short-lived admin JWT
# inside the backend container so no secret is passed through the shell.
cmd_readiness() {
    in_ct "docker compose exec -T virtual-lab-backend node -e \"const jwt=require('\''jsonwebtoken'\'');const t=jwt.sign({vu_id:process.env.SMOKE_USER||'\''admin'\'',role:'\''admin'\''},process.env.BACKEND_JWT_SECRET,{expiresIn:'\''2m'\''});fetch('\''http://localhost:3000/network/readiness'\'',{headers:{authorization:'\''Bearer '\''+t}}).then(r=>r.json()).then(b=>{console.log('\''mode='\''+b.mode,'\''ready_for_active='\''+b.ready_for_active);for(const c of b.checks)if(c.status!=='\''pass'\'')console.log(c.status.toUpperCase(),c.key,'\''|'\'',c.detail);}).catch(e=>{console.error(e.message);process.exit(1)})\""
}

cmd_vnets() {
    on_host 'echo "=== VNETS ==="; pvesh get /cluster/sdn/vnets --output-format json; echo; echo "=== ZONES ==="; pvesh get /cluster/sdn/zones --output-format json'
}

cmd_status() {
    in_ct 'docker compose ps --format "{{.Service}} {{.State}} {{.Image}}"'
}

main() {
    (( $# >= 1 )) || { usage >&2; exit 2; }
    local command="$1"
    shift
    # Only configure-gateway takes arguments; everything else stays arity-checked.
    if [[ "$command" != "configure-gateway" ]] && (( $# > 0 )); then
        fail "$command takes no arguments"
    fi
    case "$command" in
        configure-gateway) cmd_configure_gateway "$@" ;;
        deploy) cmd_deploy ;;
        preflight-tokens) cmd_preflight_tokens ;;
        attempt-status) cmd_attempt_status ;;
        attempt-detail) cmd_attempt_detail ;;
        settings) cmd_settings ;;
        groups) cmd_groups ;;
        readiness) cmd_readiness ;;
        vnets) cmd_vnets ;;
        status) cmd_status ;;
        --help | -h | help) usage ;;
        *) fail "unknown command: $command" ;;
    esac
}

main "$@"
