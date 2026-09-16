#!/bin/bash
set -euo pipefail
test "$(id -u)" = 0
test "$#" -ge 2
base=/var/lib/silex-registry-stage
action=$1
name=$2
shift 2
[[ "$name" =~ ^stage-[0-9]{8}T[0-9]{6}Z$ ]]
test ! -L "$base"
test ! -L "$base/data"
test ! -L "$base/backups"
test -d "$base/data"
test -d "$base/backups"
case "$action" in
  create)
    test "$#" = 0
    test ! -e "$base/backups/$name"
    args=(create /data "/snapshots/$name")
    ;;
  verify)
    test "$#" = 1
    [[ "$1" =~ ^[a-f0-9]{64}$ ]]
    test -d "$base/backups/$name"
    test ! -L "$base/backups/$name"
    args=(verify "/snapshots/$name" "$1")
    ;;
  *) exit 2 ;;
esac
# The live store is locked by Snapshot::create. The output is outside the
# release and the web root, and this administrative process has no network.
exec systemd-run --quiet --wait --pipe --collect --unit=silex-registry-stage-snapshot \
  -p "RootDirectory=$base/root" -p User=silex-registry-stage -p Group=silex-registry-stage \
  -p "BindPaths=$base/data:/data $base/backups:/snapshots" \
  -p "BindReadOnlyPaths=$base/current:/app" \
  -p ProtectSystem=strict -p 'ReadWritePaths=/data /snapshots' -p PrivateNetwork=yes \
  -p NoNewPrivileges=yes -p 'CapabilityBoundingSet=' -p 'Environment=PHP_INI_SCAN_DIR=' \
  -p MemoryMax=512M -p TasksMax=8 -p CPUQuota=100% \
  /usr/bin/php8.2 -c /etc/stage/php.ini /app/server/bin/snapshot.php "${args[@]}"
