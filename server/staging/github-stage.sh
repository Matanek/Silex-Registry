#!/bin/bash
set -euo pipefail
test "$(id -u)" = 0
test "$#" = 1
action=$1
source=/var/lib/silex-registry-stage/current/server/staging/silex-registry-stage-github.conf
target=/etc/systemd/system/silex-registry-stage.service.d/github.conf
case "$action" in
  enable)
    test -f /var/lib/silex-registry-stage/root/usr/lib/php/20220829/curl.so
    test -f /etc/ssl/certs/ca-certificates.crt
    test -f /etc/resolv.conf
    test ! -e "$target"
    install -d -m 0755 "$(dirname "$target")"
    install -m 0644 "$source" "$target"
    ;;
  disable)
    test -f "$target"
    test ! -L "$target"
    rm "$target"
    ;;
  *) exit 2 ;;
esac
systemctl daemon-reload
systemctl restart silex-registry-stage.service
systemctl is-active --quiet silex-registry-stage.service
