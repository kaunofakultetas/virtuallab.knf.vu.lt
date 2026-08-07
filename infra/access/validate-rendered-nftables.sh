#!/usr/bin/env bash

set -Eeuo pipefail

readonly script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly repo_root="$(cd -- "${script_dir}/../.." && pwd)"
readonly input_path="${1:-${script_dir}/vlan-2000-validation-input.json}"

[[ -f "$input_path" ]] || {
    printf 'Access desired-state input does not exist: %s\n' "$input_path" >&2
    exit 1
}

readonly tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

readonly rendered_path="${tmp_dir}/rendered.json"
readonly rules_path="${tmp_dir}/access.nft"

npm --silent --prefix "${repo_root}/backend" run render-access -- "$input_path" >"$rendered_path"

revision="$(node -e '
const fs = require("node:fs");
const rendered = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (typeof rendered.revision !== "string" || typeof rendered.files?.nftables !== "string") {
    throw new Error("Renderer output is missing revision or nftables content");
}
fs.writeFileSync(process.argv[2], rendered.files.nftables);
process.stdout.write(rendered.revision);
' "$rendered_path" "$rules_path")"

grep -qF "# Access desired-state revision ${revision}." "$rules_path" || {
    printf 'Rendered nftables content is missing revision marker %s.\n' "$revision" >&2
    exit 1
}

docker run --rm --cap-add NET_ADMIN \
    --volume "${rules_path}:/tmp/access.nft:ro" \
    alpine:3.22 \
    sh -c 'apk add --no-cache nftables >/dev/null && nft -c -f /tmp/access.nft'

printf 'Access nftables syntax accepted for revision %s.\n' "$revision"