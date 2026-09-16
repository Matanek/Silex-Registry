#!/bin/bash
set -euo pipefail
# Run as root on the authorized staging host after prepare-runtime.sh.
test "$(id -u)" = 0
test "$#" = 2
archive=$(realpath "$1")
revision=$2
[[ "$revision" =~ ^[a-f0-9]{40}$ ]]
base=/var/lib/silex-registry-stage
root="$base/root"
config=$(cd "$(dirname "$0")" && pwd)
test -x "$root/usr/sbin/php-fpm8.2"
test ! -L "$base"
for account in silex-registry-stage silex-registry-stage-web; do
  if ! id "$account" >/dev/null 2>&1; then
    useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$account"
  fi
done
install -d -m 0755 "$base/releases" "$root/etc/stage" "$root/app" "$root/data" "$root/snapshots" "$root/run/stage" "$root/run/web" "$root/tmp"
install -d -m 0755 "$root/etc/ssl/certs"
touch "$root/etc/resolv.conf"
install -d -m 0700 -o silex-registry-stage -g silex-registry-stage "$base/data"
install -d -m 0700 -o silex-registry-stage -g silex-registry-stage "$base/backups"
install -d -m 0750 -o root -g silex-registry-stage-web "$base/gateway"
release="$base/releases/$revision"
archive_digest=$(sha256sum "$archive")
archive_digest=${archive_digest%% *}
if ! test -d "$release"; then
  install -d -m 0755 "$release"
  tar -xf "$archive" -C "$release" --no-same-owner
  chown -R root:root "$release"
  printf '%s\n' "$archive_digest" > "$release/.archive-sha256"
fi
test "$(<"$release/.archive-sha256")" = "$archive_digest"
test -f "$release/server/public/index.php"
ln -s "$release" "$base/current.next"
mv -Tf "$base/current.next" "$base/current"
getent passwd silex-registry-stage silex-registry-stage-web > "$root/etc/passwd"
getent group silex-registry-stage silex-registry-stage-web > "$root/etc/group"
for name in php.ini fpm.conf httpd.conf isolation.php; do
  install -m 0644 "$config/$name" "$root/etc/stage/$name"
done
printf 'immutable test marker\n' > "$root/etc/stage/read-only-canary"
printf 'host-only test marker\n' > "$base/host-canary"
chmod 0600 "$base/host-canary"
if ! test -f "$base/gateway/tls.key"; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj /CN=localhost \
    -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
    -addext 'basicConstraints=critical,CA:FALSE' \
    -keyout "$base/gateway/tls.key" -out "$base/gateway/tls.crt" 2>/dev/null
  chown silex-registry-stage-web:silex-registry-stage-web "$base/gateway/tls.key"
  chmod 0600 "$base/gateway/tls.key"
  chmod 0644 "$base/gateway/tls.crt"
fi
initialize() {
  systemd-run --quiet --wait --pipe --collect --unit="silex-registry-stage-$1" \
    -p "RootDirectory=$root" -p User=silex-registry-stage -p Group=silex-registry-stage \
    -p "BindPaths=$base/data:/data" -p "BindReadOnlyPaths=$base/current:/app" \
    -p ProtectSystem=strict -p ReadWritePaths=/data -p PrivateNetwork=yes \
    -p 'Environment=PHP_INI_SCAN_DIR=' \
    /usr/bin/php8.2 -c /etc/stage/php.ini /app/server/bin/storage.php "$1" /data
}
if ! test -f "$base/data/registry.sqlite"; then initialize init; fi
if ! test -f "$base/data/login.key"; then initialize login-init; fi
install -m 0644 "$config/limits.json" "$base/data/limits.json"
for name in silex-registry-stage.service silex-registry-stage-web.service; do
  install -m 0644 "$config/$name" "/etc/systemd/system/$name"
done
install -d -m 0755 /usr/local/libexec
install -m 0700 "$config/fixture.sh" /usr/local/libexec/silex-registry-stage-fixture
install -m 0700 "$config/snapshot-stage.sh" /usr/local/libexec/silex-registry-stage-snapshot
install -m 0700 "$config/github-stage.sh" /usr/local/libexec/silex-registry-stage-github
systemd-analyze verify /etc/systemd/system/silex-registry-stage.service /etc/systemd/system/silex-registry-stage-web.service
systemctl daemon-reload
systemctl reset-failed silex-registry-stage.service silex-registry-stage-web.service
systemctl enable silex-registry-stage.service silex-registry-stage-web.service
systemctl restart silex-registry-stage.service
systemctl restart silex-registry-stage-web.service
systemctl is-active silex-registry-stage.service silex-registry-stage-web.service
status=$(curl --silent --show-error --connect-timeout 2 --max-time 5 \
  --retry 5 --retry-connrefused --retry-delay 1 --retry-max-time 15 \
  --cacert "$base/gateway/tls.crt" -o /dev/null -w '%{http_code}' \
  https://127.0.0.1:18765/v2/session)
test "$status" = 401
printf 'Stage revision: %s\n' "$revision"
