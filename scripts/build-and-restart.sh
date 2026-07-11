#!/usr/bin/env bash
# Install deps, build, restart the systemd service. Runs ON THE SERVER,
# invoked by scripts/deploy.sh on every deploy. Safe to re-run.

set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

# Ensure the native `claude` symlink is visible to any subprocess.
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m%s\033[0m\n' "  ✓ $*"; }

# Keep Node's heap modest — this box often has <512 MB RAM.
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=384}"

bold "[1/3] bun install"
bun install --frozen-lockfile
ok "deps installed"

bold "[2/3] build (server + web)"
# The protocol-search MCP now ships as the external npm package
# @mengbingrock/labee-protocol-searcher (prebuilt dist in node_modules), so it
# no longer needs a workspace build here.
bun run turbo run build --filter=@labee/server --filter=@labee/web
ok "build complete"

bold "[3/3] restart service"
sudo systemctl restart labee
sleep 2
sudo systemctl is-active labee --quiet && ok "labee is running" || {
  echo "    service did NOT come up. Last 30 log lines:"
  sudo journalctl -u labee -n 30 --no-pager
  exit 1
}
