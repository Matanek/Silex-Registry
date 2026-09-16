#!/bin/bash
set -euo pipefail
# Download and unpack a private runtime. Never install packages into the host.
test "$(id -u)" = 0
if systemctl is-active --quiet silex-registry-stage.service || systemctl is-active --quiet silex-registry-stage-web.service; then
  printf 'Stop the staging services before replacing their private runtime.\n' >&2
  exit 1
fi
base=/var/lib/silex-registry-stage
test ! -L "$base"
aptroot="$base/apt-bookworm"
install -d -m 0755 "$base" "$base/root" "$aptroot/lists/partial" "$aptroot/archives/partial"
install -m 0644 "$(dirname "$0")/runtime.sources.list" "$aptroot/sources.list"
touch "$aptroot/status"
options=(-o "Dir::Etc::sourcelist=$aptroot/sources.list" -o Dir::Etc::sourceparts=-
  -o "Dir::State::lists=$aptroot/lists" -o "Dir::State::status=$aptroot/status"
  -o "Dir::Cache::archives=$aptroot/archives" -o APT::Install-Recommends=false)
apt-get "${options[@]}" update
apt-get "${options[@]}" --download-only --yes install \
  php8.2-cli php8.2-fpm php8.2-intl php8.2-mbstring php8.2-sqlite3 apache2-bin openssl
for package in "$aptroot"/archives/*.deb; do
  dpkg-deb -x "$package" "$base/root"
done
sha256sum "$aptroot"/archives/*.deb > "$base/runtime-sha256.txt"
chroot "$base/root" /usr/bin/php8.2 -n -v
