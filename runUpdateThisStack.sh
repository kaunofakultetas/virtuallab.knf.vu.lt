#!/usr/bin/env bash

set -Eeuo pipefail

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"
readonly GIT=(git -c "safe.directory=$ROOT_DIR")

allow_dirty=false
if [[ "${1:-}" == "--allow-dirty" ]]; then
	allow_dirty=true
	shift
fi
(( $# == 0 )) || {
	printf 'Usage: %s [--allow-dirty]\n' "$0" >&2
	exit 2
}

if (( EUID == 0 )); then
	readonly DOCKER=(docker)
else
	readonly DOCKER=(sudo docker)
fi
readonly COMPOSE=("${DOCKER[@]}" compose)
GIT_SHA="$("${GIT[@]}" rev-parse --verify HEAD)" || {
	printf '[deploy] ERROR: cannot resolve the deployed Git revision\n' >&2
	exit 1
}
[[ "$GIT_SHA" =~ ^[0-9a-f]{40}$ ]] || {
	printf '[deploy] ERROR: deployed Git revision is invalid\n' >&2
	exit 1
}
readonly GIT_SHA
if [[ "$allow_dirty" == true ]]; then
	readonly IMAGE_TAG="${GIT_SHA:0:12}-rehearsal-$(date -u +%Y%m%d%H%M%S)"
else
	readonly IMAGE_TAG="${GIT_SHA:0:12}"
fi
readonly BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/_DATA/deployment-backups}"
readonly BACKUP_FILE="$BACKUP_DIR/postgres-${IMAGE_TAG}-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"

previous_backend_image=""
previous_endpoint_image=""
deployment_started=false

log() {
	printf '[deploy] %s\n' "$*"
}

fail() {
	printf '[deploy] ERROR: %s\n' "$*" >&2
	exit 1
}

container_image_id() {
	local container_name="$1"
	"${DOCKER[@]}" inspect --format '{{.Image}}' "$container_name" 2>/dev/null || true
}

rollback() {
	local exit_code="$?"
	local rollback_services=()

	if [[ "$deployment_started" != true || $exit_code -eq 0 ]]; then
		return
	fi

	log "Deployment failed; restoring the previous application images"
	if [[ -n "$previous_backend_image" ]]; then
		"${DOCKER[@]}" tag "$previous_backend_image" virtual-lab-backend:rollback
		rollback_services+=(virtual-lab-backend)
	fi
	if [[ -n "$previous_endpoint_image" ]]; then
		"${DOCKER[@]}" tag "$previous_endpoint_image" virtual-lab-endpoint:rollback
		rollback_services+=(virtual-lab-endpoint)
	fi

	if (( ${#rollback_services[@]} > 0 )); then
		VIRTUAL_LAB_IMAGE_TAG=rollback "${COMPOSE[@]}" up -d --no-build --wait \
			"${rollback_services[@]}" || \
			log "Automatic application rollback failed; database backup: $BACKUP_FILE"
	fi

	log "Database changes are not automatically reversed; backup: $BACKUP_FILE"
}

trap rollback EXIT

[[ -f .env ]] || fail ".env is required"
if [[ "$allow_dirty" == true ]]; then
	log "WARNING: development rehearsal permits an uncommitted checkout"
else
	"${GIT[@]}" diff --quiet || fail "tracked working tree changes must be committed before deployment"
	"${GIT[@]}" diff --cached --quiet || fail "staged changes must be committed before deployment"
	"${GIT[@]}" status --porcelain --untracked-files=normal | grep -q . && \
		fail "untracked files must be committed or ignored before deployment"
fi

mkdir -p "$BACKUP_DIR" ./_DATA/postgres ./_LOGS
touch ./_LOGS/access.log

log "Validating Compose configuration for revision $GIT_SHA"
VIRTUAL_LAB_IMAGE_TAG="$IMAGE_TAG" "${COMPOSE[@]}" config --quiet

log "Starting PostgreSQL for backup and schema validation"
VIRTUAL_LAB_IMAGE_TAG="$IMAGE_TAG" "${COMPOSE[@]}" up -d --wait virtual-lab-postgres

log "Backing up PostgreSQL to $BACKUP_FILE"
VIRTUAL_LAB_IMAGE_TAG="$IMAGE_TAG" "${COMPOSE[@]}" exec -T virtual-lab-postgres \
	sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' | gzip > "$BACKUP_FILE"

log "Building immutable application images with tag $IMAGE_TAG"
VIRTUAL_LAB_IMAGE_TAG="$IMAGE_TAG" "${COMPOSE[@]}" build --pull virtual-lab-backend virtual-lab-endpoint

previous_backend_image="$(container_image_id virtual-lab-backend)"
previous_endpoint_image="$(container_image_id virtual-lab-endpoint)"
deployment_started=true

log "Applying database schema in one transaction"
VIRTUAL_LAB_IMAGE_TAG="$IMAGE_TAG" "${COMPOSE[@]}" exec -T virtual-lab-postgres \
	sh -c 'psql -v ON_ERROR_STOP=1 --single-transaction -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
	< backend/schema.sql

log "Starting revision $GIT_SHA and waiting for service health"
VIRTUAL_LAB_IMAGE_TAG="$IMAGE_TAG" "${COMPOSE[@]}" up -d --no-build --wait

smoke_user="$(VIRTUAL_LAB_IMAGE_TAG="$IMAGE_TAG" "${COMPOSE[@]}" exec -T virtual-lab-postgres \
	sh -c 'psql -Atq -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
		-c "SELECT vu_id FROM users WHERE role = '\''admin'\'' ORDER BY vu_id LIMIT 1"')"
[[ -n "$smoke_user" ]] || fail "an admin user is required for the reconciliation smoke test"

log "Running authenticated read-only reconciliation smoke test"
VIRTUAL_LAB_IMAGE_TAG="$IMAGE_TAG" "${COMPOSE[@]}" exec -T \
	-e "DEPLOYMENT_SMOKE_USER=$smoke_user" virtual-lab-backend node <<'NODE'
const { randomUUID } = require("node:crypto");
const jwt = require("jsonwebtoken");

const token = jwt.sign(
	{ vu_id: process.env.DEPLOYMENT_SMOKE_USER, role: "admin" },
	process.env.BACKEND_JWT_SECRET,
	{ expiresIn: "5m" },
);

fetch("http://localhost:3000/network/reconciliation-attempts", {
	method: "POST",
	headers: {
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
	},
	body: JSON.stringify({
		apply: false,
		idempotency_key: `deployment-${randomUUID()}`,
	}),
}).then(async (response) => {
	const body = await response.json();
	if (response.status !== 202 || body.status !== "succeeded") {
		throw new Error(`reconciliation smoke test failed with HTTP ${response.status}`);
	}
	process.stdout.write(JSON.stringify({
		attempt_id: body.id,
		status: body.status,
		checks: Array.isArray(body.checks) ? body.checks.length : 0,
		actions: Array.isArray(body.actions) ? body.actions.length : 0,
	}) + "\n");
}).catch((error) => {
	console.error(error.message);
	process.exit(1);
});
NODE

deployment_started=false
log "Deployment completed successfully"
"${COMPOSE[@]}" ps
