#!/bin/sh

set -eu

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
registry_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
workspace_root=$(dirname "$registry_root")
backup_root="$workspace_root/Backups/Silex-Registry"
maintenance_origin=${SILEX_REGISTRY_MAINTENANCE_ORIGIN:-https://registry.silex-lang.org}
case "$maintenance_origin" in
    https://registry.silex-lang.org|https://silex-registry.silex-lang.workers.dev) ;;
    *) echo 'invalid registry maintenance origin' >&2; exit 1 ;;
esac

mkdir -p "$backup_root"
maintenance_token=$(security find-generic-password \
    -s org.silex.registry.production.MAINTENANCE_TOKEN \
    -a silex-registry -w)
case "$maintenance_token" in
    ''|*[!0-9a-f]*) echo 'invalid registry maintenance token' >&2; exit 1 ;;
esac
if [ "${#maintenance_token}" -ne 64 ]; then
    echo 'invalid registry maintenance token length' >&2
    exit 1
fi

export REGISTRY_MAINTENANCE_TOKEN="$maintenance_token"
export WRANGLER_LOG_PATH
WRANGLER_LOG_PATH=$(mktemp -d "$backup_root/wrangler-maintenance.XXXXXX")
trap 'rm -rf -- "$WRANGLER_LOG_PATH"' EXIT

cd "$registry_root"
node server/cloudflare/admin/run-maintenance.mjs \
    --remote silex-registry silex-registry \
    server/cloudflare/wrangler.production.toml \
    "$maintenance_origin" \
    "$backup_root" --apply-retention
