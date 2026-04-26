#!/usr/bin/env bash
# Install deps, build, restart the systemd service. Runs ON THE SERVER,
# invoked by scripts/deploy.sh on every deploy.
#
# Safe to re-run.

set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

# Ensure the native `claude` symlink is visible to any subprocess that might
# peek at PATH during the build.
export PATH="$HOME/.local/bin:$PATH"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m%s\033[0m\n' "  ✓ $*"; }

# Keep Node's heap modest — this box often has <512 MB RAM.
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=384}"

bold "[1/3] npm ci"
# Use install instead of ci if package-lock might be out of sync; ci is
# faster and more deterministic when lockfile matches.
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund --loglevel=warn
else
  npm install --no-audit --no-fund --loglevel=warn
fi
ok "deps installed"

bold "[2/3] next build"
npm run build
ok "build complete"

bold "[3/3] restart service"
sudo systemctl restart monterey
sleep 2
sudo systemctl is-active monterey --quiet && ok "monterey is running" || {
  echo "    service did NOT come up. Last 30 log lines:"
  sudo journalctl -u monterey -n 30 --no-pager
  exit 1
}
