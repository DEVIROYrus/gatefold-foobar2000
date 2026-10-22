#!/usr/bin/env bash
# Playwright's Chromium, and the same system packages `playwright install --with-deps chromium` would install
# (the list is read from the installed Playwright, so it always matches), without that command's
# apt-get update + install on every run: packages already on the runner image are checked with dpkg, and
# only the missing ones are installed — from .deb files cached per image version.
# (Xvfb is left out: the tests run headless.)
set -euo pipefail
t0=$SECONDS
PW=$(python -c 'import os, playwright; print(os.path.dirname(playwright.__file__))')
python -m playwright install chromium
. /etc/os-release
if ! pkgs=$("$PW/driver/node" -e "
    const d = require('$PW/driver/package/lib/server/registry/nativeDeps.js').deps['${ID}${VERSION_ID}-x64'];
    if (!d) process.exit(3);
    console.log([...d.tools.filter((p) => p !== 'xvfb'), ...d.chromium].join(' '));"); then
  echo "no package list for ${ID} ${VERSION_ID}: the full install"
  python -m playwright install-deps chromium
  exit 0
fi
missing=$(for p in $pkgs; do dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q 'install ok installed' || echo "$p"; done | xargs)
if [ -z "$missing" ]; then echo "Chromium ready, all $(wc -w <<<"$pkgs") system packages present ($((SECONDS - t0)) s)"; exit 0; fi
echo "missing on this image: $missing"
D="$HOME/.cache/pw-debs"; mkdir -p "$D"
APT=(sudo apt-get -o DPkg::Lock::Timeout=120 -o Acquire::Retries=3 -y -qq --no-install-recommends)
if ! ls "$D"/*.deb >/dev/null 2>&1; then
  sudo apt-get -o DPkg::Lock::Timeout=120 update -qq
  # shellcheck disable=SC2086
  "${APT[@]}" install --download-only -o Dir::Cache::archives="$D" $missing
  sudo chown -R "$(id -u):$(id -g)" "$D"; rm -rf "$D/partial" "$D/lock"
fi
# shellcheck disable=SC2086
if ! sudo dpkg -i "$D"/*.deb >/dev/null; then
  echo 'the cached packages did not install cleanly: apt fills the gaps'
  sudo apt-get -o DPkg::Lock::Timeout=120 update -qq
  "${APT[@]}" install $missing
fi
echo "Chromium ready, installed: $missing ($((SECONDS - t0)) s)"
