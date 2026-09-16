#!/bin/bash
set -euo pipefail
test "$(id -u)" = 0
test "$#" -ge 1
base=/var/lib/silex-registry-stage
work="$base/migration-work"
input="$base/migration-input"
test ! -L "$base"
test ! -L "$work"
test ! -L "$input"
test -d "$input/bundle"
test -f "$input/owners.json"
install -d -m 0700 -o silex-registry-stage -g silex-registry-stage "$work"
install -d -m 0755 "$base/root/qualification" "$base/root/input"
action=$1
shift
case "$action" in
  init)
    test "$#" = 0
    test ! -e "$work/data"
    install -d -m 0700 -o silex-registry-stage -g silex-registry-stage "$work/data"
    args=(/app/server/bin/storage.php init /qualification/data)
    ;;
  import)
    test "$#" -ge 2
    instance=$1; shift
    [[ "$instance" = data || "$instance" = restored ]]
    args=(/app/server/bin/migrate.php "/qualification/$instance" /input/bundle /input/owners.json "$@")
    ;;
  snapshot)
    test "$#" = 0
    args=(/app/server/bin/snapshot.php create /qualification/data /qualification/snapshot)
    ;;
  verify)
    test "$#" = 1
    [[ "$1" =~ ^[a-f0-9]{64}$ ]]
    args=(/app/server/bin/snapshot.php verify /qualification/snapshot "$1")
    ;;
  restore)
    test "$#" = 1
    [[ "$1" =~ ^[a-f0-9]{64}$ ]]
    args=(/app/server/bin/snapshot.php restore /qualification/snapshot /qualification/restored "$1")
    ;;
  *) exit 2 ;;
esac
# Deliberately no bind of the existing stage's /data, public /srv or host home.
# Input and exact deployed code are read-only. Migration never has network access.
exec systemd-run --quiet --wait --pipe --collect --unit=silex-registry-stage-migration \
  -p "RootDirectory=$base/root" -p User=silex-registry-stage -p Group=silex-registry-stage \
  -p "BindPaths=$work:/qualification" -p "BindReadOnlyPaths=$base/current:/app $input:/input" \
  -p ProtectSystem=strict -p ReadWritePaths=/qualification -p PrivateNetwork=yes \
  -p NoNewPrivileges=yes -p 'CapabilityBoundingSet=' -p 'Environment=PHP_INI_SCAN_DIR=' \
  -p MemoryMax=512M -p TasksMax=8 -p CPUQuota=100% \
  /usr/bin/php8.2 -c /etc/stage/php.ini "${args[@]}"
