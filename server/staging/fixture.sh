#!/bin/bash
set -euo pipefail
test "$(id -u)" = 0
test "$#" = 0
# Private administrator entry point, never exposed by HTTP. Input stays on stdin.
exec systemd-run --quiet --wait --pipe --collect --unit=silex-registry-stage-fixture \
  -p RootDirectory=/var/lib/silex-registry-stage/root \
  -p User=silex-registry-stage -p Group=silex-registry-stage \
  -p BindPaths=/var/lib/silex-registry-stage/data:/data \
  -p BindReadOnlyPaths=/var/lib/silex-registry-stage/current:/app \
  -p ProtectSystem=strict -p ReadWritePaths=/data -p PrivateNetwork=yes \
  -p NoNewPrivileges=yes -p 'CapabilityBoundingSet=' -p 'Environment=PHP_INI_SCAN_DIR=' \
  /usr/bin/php8.2 -c /etc/stage/php.ini /app/server/tests/fixture.php
