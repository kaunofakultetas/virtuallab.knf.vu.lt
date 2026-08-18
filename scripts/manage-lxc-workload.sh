#!/usr/bin/env bash

set -Eeuo pipefail

readonly DEFAULT_INSTALL_ROOT="/srv/virtual-proxmox-lab"

usage() {
    cat <<'EOF'
Usage:
  sudo ./scripts/manage-lxc-workload.sh install --role <guacamole|api-docker> --repository <url> [options]
  sudo ./scripts/manage-lxc-workload.sh update  --role <guacamole|api-docker> [options]
  sudo ./scripts/manage-lxc-workload.sh status  --role <guacamole|api-docker> [options]

Options:
  --role ROLE          Workload assigned to this LXC.
  --repository URL     Git repository URL. Required for install.
  --ref REF            Branch or tag to deploy (default: main).
  --install-root PATH  Repository checkout path (default: /srv/virtual-proxmox-lab).
  --help               Show this help.

The script does not create secrets, copy existing data, configure Proxmox, or
enable backups. For api-docker, create INSTALL_ROOT/.env before starting the
stack. Install stops after checkout when that file is absent.
EOF
}

fail() {
    printf 'Error: %s\n' "$*" >&2
    exit 1
}

require_root() {
    [[ "${EUID}" -eq 0 ]] || fail "run this command as root"
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

validate_host_role() {
    local hostname
    hostname="$(hostname -s)"
    [[ "${hostname}" == "${role}" ]] || fail "role ${role} must run on hostname ${role}, not ${hostname}"
}

compose_files() {
    case "${role}" in
        guacamole)
            printf '%s\n' "${install_root}/infra/guacamole/compose.yaml"
            ;;
        api-docker)
            printf '%s\n' "${install_root}/docker-compose.yml"
            ;;
    esac
}

compose() {
    local compose_file
    compose_file="$(compose_files)"
    docker compose --project-directory "$(dirname "${compose_file}")" --file "${compose_file}" "$@"
}

install_docker() {
    export DEBIAN_FRONTEND=noninteractive
    printf 'Acquire::ForceIPv4 "true";\n' >/etc/apt/apt.conf.d/99virtual-lab-ipv4
    sed -i \
        -e 's|http://archive.ubuntu.com/ubuntu|https://archive.ubuntu.com/ubuntu|g' \
        -e 's|http://security.ubuntu.com/ubuntu|https://security.ubuntu.com/ubuntu|g' \
        /etc/apt/sources.list
    apt-get update
    apt-get install -y ca-certificates docker.io docker-compose-v2 git
    systemctl enable --now docker
}

validate_checkout() {
    [[ -d "${install_root}/.git" ]] || fail "no Git checkout found at ${install_root}; run install first"
    [[ -f "$(compose_files)" ]] || fail "Compose file is missing for role ${role}"
}

prepare_runtime() {
    case "${role}" in
        guacamole)
            install -d -m 0755 "${install_root}/infra/guacamole/data"
            ;;
        api-docker)
            [[ -f "${install_root}/.env" ]] || fail "create ${install_root}/.env from backend/.env.example before starting"
            install -d -m 0750 "${install_root}/_DATA/postgres" "${install_root}/_LOGS"
            docker network inspect external >/dev/null 2>&1 || docker network create external >/dev/null
            ;;
    esac
}

install_workload() {
    [[ -n "${repository}" ]] || fail "--repository is required for install"
    [[ ! -e "${install_root}" ]] || fail "${install_root} already exists; use update or choose another --install-root"

    install_docker
    install -d -m 0755 "$(dirname "${install_root}")"
    git clone --branch "${git_ref}" --single-branch "${repository}" "${install_root}"
    validate_checkout

    if [[ "${role}" == "api-docker" && ! -f "${install_root}/.env" ]]; then
        printf 'Checkout installed at %s. Create .env, then run update to start the stack.\n' "${install_root}"
        return
    fi

    prepare_runtime
    compose pull --ignore-buildable
    compose up -d --build --remove-orphans
}

update_workload() {
    require_command git
    require_command docker
    validate_checkout

    if [[ -n "$(git -C "${install_root}" status --porcelain)" ]]; then
        fail "checkout has local changes; commit or remove them before updating"
    fi

    git -C "${install_root}" fetch --prune origin
    git -C "${install_root}" checkout "${git_ref}"
    git -C "${install_root}" pull --ff-only origin "${git_ref}"
    prepare_runtime
    compose config --quiet
    compose pull --ignore-buildable
    compose up -d --build --remove-orphans
}

status_workload() {
    require_command docker
    validate_checkout
    compose ps
}

action="${1:-}"
if [[ "${action}" == "--help" || "${action}" == "-h" ]]; then
    usage
    exit 0
fi
[[ "${action}" == "install" || "${action}" == "update" || "${action}" == "status" ]] || {
    usage >&2
    exit 2
}
shift

role=""
repository=""
git_ref="main"
install_root="${DEFAULT_INSTALL_ROOT}"

while (($# > 0)); do
    case "$1" in
        --role)
            (($# >= 2)) || fail "--role requires a value"
            role="$2"
            shift 2
            ;;
        --repository)
            (($# >= 2)) || fail "--repository requires a value"
            repository="$2"
            shift 2
            ;;
        --ref)
            (($# >= 2)) || fail "--ref requires a value"
            git_ref="$2"
            shift 2
            ;;
        --install-root)
            (($# >= 2)) || fail "--install-root requires a value"
            install_root="$2"
            shift 2
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            fail "unknown option: $1"
            ;;
    esac
done

[[ "${role}" == "guacamole" || "${role}" == "api-docker" ]] || fail "--role must be guacamole or api-docker"
[[ "${install_root}" == /* ]] || fail "--install-root must be an absolute path"

require_root
validate_host_role

case "${action}" in
    install)
        require_command apt-get
        install_workload
        ;;
    update)
        update_workload
        ;;
    status)
        status_workload
        ;;
esac