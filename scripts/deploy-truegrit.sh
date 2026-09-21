#!/usr/bin/env bash
# Deploy the Labee server to the truegrit EC2 box (the host labee.online now
# points at), as a FRESH install next to the Protocol-Searcher MCP:
#
#   - builds server + web locally (the box has no bun and a nearly full disk)
#   - copies only the built artifacts to /opt/labee (≈ 10 MB)
#   - writes /etc/labee.env (keeps an existing one; generates SESSION_PASSWORD once)
#   - installs a systemd unit `labee` (node 22, port 3010, loopback only)
#   - routes labee.online → Labee in Caddy, keeping /mcp → the MCP on :3001
#   - verifies from outside
#
# Usage:  bash scripts/deploy-truegrit.sh
# Env:    SSH_HOST (default 3.144.175.137)  SSH_KEY (default ~/.ssh/truegrit-default-key.pem)
#         SKIP_BUILD=1 to reuse apps/server/dist + apps/web/dist
set -euo pipefail

SSH_HOST="${SSH_HOST:-3.144.175.137}"
SSH_USER="${SSH_USER:-ubuntu}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/truegrit-default-key.pem}"
PORT="${LABEE_PORT:-3010}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 $SSH_USER@$SSH_HOST"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$SSH_KEY" ] || die "SSH key not found: $SSH_KEY"
[ -f "$ROOT/.env.production" ] || die "$ROOT/.env.production (Google OAuth client) is required"
$SSH 'echo "ok: $(hostname)"' >/dev/null || die "SSH failed"

# --- 1. build locally -------------------------------------------------------
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  bold "==> Building server + web locally"
  (cd "$ROOT" && bun run turbo run build --filter=@labee/server --filter=@labee/web >/dev/null)
fi
[ -f "$ROOT/apps/server/dist/bin.mjs" ] || die "apps/server/dist/bin.mjs missing"
[ -f "$ROOT/apps/web/dist/index.html" ] || die "apps/web/dist/index.html missing"

# --- 2. stage + copy --------------------------------------------------------
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/server"
cp -R "$ROOT/apps/server/dist/." "$STAGE/server/"
cp -R "$ROOT/apps/web/dist" "$STAGE/server/client"     # served next to bin.mjs
cp -R "$ROOT/scripts" "$STAGE/scripts"
bold "==> Copying artifacts → $SSH_HOST:/opt/labee ($(du -sh "$STAGE" | cut -f1))"
$SSH 'sudo mkdir -p /opt/labee && sudo chown -R ubuntu:ubuntu /opt/labee'
rsync -az --delete -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new" "$STAGE/" "$SSH_USER@$SSH_HOST:/opt/labee/"

# --- 3. env file ------------------------------------------------------------
bold "==> Environment (/etc/labee.env)"
GOOGLE_ID="$(grep -E '^GOOGLE_CLIENT_ID=' "$ROOT/.env.production" | cut -d= -f2-)"
GOOGLE_SECRET="$(grep -E '^GOOGLE_CLIENT_SECRET=' "$ROOT/.env.production" | cut -d= -f2-)"
[ -n "$GOOGLE_ID" ] && [ -n "$GOOGLE_SECRET" ] || die "GOOGLE_CLIENT_ID/SECRET missing in .env.production"
$SSH "PORT=$PORT GOOGLE_ID='$GOOGLE_ID' GOOGLE_SECRET='$GOOGLE_SECRET' bash -s" <<'REMOTE'
set -euo pipefail
SESSION_PASSWORD=""
EXTRA=""
if [ -f /etc/labee.env ]; then
  sudo cp -a /etc/labee.env /etc/labee.env.bak.$(date +%s)
  SESSION_PASSWORD="$(sudo grep -E '^SESSION_PASSWORD=' /etc/labee.env | cut -d= -f2- || true)"
  # Keep every variable this script does not manage (API keys, Stripe, etc.).
  EXTRA="$(sudo grep -vE '^(NODE_ENV|LABEE_MODE|LABEE_PORT|LABEE_HOST|LABEE_DATA_DIR|DECK_ROOT|SKILLS_ROOTS|SESSION_PASSWORD|COOKIE_SECURE|SIGNUP_ENABLED|GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|GOOGLE_REDIRECT_URI|PROTOCOLS_MCP_URL|PROTOCOLS_MCP_TOKEN)=' /etc/labee.env | grep -vE '^\s*(#|$)' || true)"
fi
if [ -z "$SESSION_PASSWORD" ]; then SESSION_PASSWORD="$(openssl rand -hex 32)"; fi
MCP_TOKEN="$(sudo grep -E '^(PROTOCOLS_MCP_TOKEN|MCP_TOKEN|AUTH_TOKEN|LABEE_MCP_TOKEN)=' /etc/labee-protocol-searcher.env 2>/dev/null | head -1 | cut -d= -f2- || true)"
sudo mkdir -p /opt/labee/data /opt/labee/decks /opt/labee/skills
sudo chown -R ubuntu:ubuntu /opt/labee
{
  echo "NODE_ENV=production"
  echo "LABEE_MODE=server"
  echo "LABEE_PORT=$PORT"
  echo "LABEE_HOST=127.0.0.1"
  echo "LABEE_DATA_DIR=/opt/labee/data"
  echo "DECK_ROOT=/opt/labee/decks"
  echo "SKILLS_ROOTS=/opt/labee/skills"
  echo "SESSION_PASSWORD=$SESSION_PASSWORD"
  echo "COOKIE_SECURE=true"
  echo "SIGNUP_ENABLED=true"
  echo "GOOGLE_CLIENT_ID=$GOOGLE_ID"
  echo "GOOGLE_CLIENT_SECRET=$GOOGLE_SECRET"
  echo "GOOGLE_REDIRECT_URI=https://labee.online/api/auth/google/callback"
  echo "PROTOCOLS_MCP_URL=http://127.0.0.1:3001/mcp"
  [ -n "$MCP_TOKEN" ] && echo "PROTOCOLS_MCP_TOKEN=$MCP_TOKEN"
  [ -n "$EXTRA" ] && printf '%s\n' "$EXTRA"
} | sudo tee /etc/labee.env >/dev/null
sudo chmod 600 /etc/labee.env
echo "  env written"
REMOTE

# --- 4. systemd unit --------------------------------------------------------
bold "==> systemd unit labee.service"
$SSH "PORT=$PORT bash -s" <<'REMOTE'
set -euo pipefail
sudo tee /etc/systemd/system/labee.service >/dev/null <<UNIT
[Unit]
Description=Labee server (labee.online)
After=network.target labee-protocol-searcher.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/labee/server
EnvironmentFile=/etc/labee.env
ExecStart=/usr/bin/node /opt/labee/server/bin.mjs
Restart=always
RestartSec=3
Environment=NODE_OPTIONS=--max-old-space-size=768

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable labee >/dev/null 2>&1 || true
sudo systemctl restart labee
sleep 3
if sudo systemctl is-active labee --quiet; then
  echo "  labee is running"
else
  sudo journalctl -u labee -n 30 --no-pager
  exit 1
fi
curl -sf -o /dev/null -w "  local /api/auth/providers → %{http_code}\n" "http://127.0.0.1:$PORT/api/auth/providers"
REMOTE

# --- 5. Caddy route ---------------------------------------------------------
bold "==> Caddy: labee.online → :$PORT, /mcp → :3001"
$SSH "PORT=$PORT bash -s" <<'REMOTE'
set -euo pipefail
CF=/etc/caddy/Caddyfile
sudo cp -a "$CF" "$CF.bak.$(date +%s)"
sudo python3 - "$PORT" <<'PY'
import re, sys
port = sys.argv[1]
cf = "/etc/caddy/Caddyfile"
s = open(cf).read()
new_block = (
    "labee.online, www.labee.online {\n"
    "\tbind 127.0.0.1\n"
    "\ttls {\n\t\tissuer acme {\n\t\t\tdisable_http_challenge\n\t\t}\n\t}\n"
    "\tencode zstd gzip\n"
    "\t# Protocol-Searcher MCP stays reachable for existing desktop clients.\n"
    "\thandle /mcp* {\n\t\treverse_proxy 127.0.0.1:3001\n\t}\n"
    "\t# Labee web app + API.\n"
    "\thandle {\n\t\treverse_proxy 127.0.0.1:" + port + "\n\t}\n"
    "}"
)
pat = re.compile(r"labee\.online, www\.labee\.online \{.*?\n\}", re.S)
if not pat.search(s):
    sys.exit("labee.online block not found in Caddyfile")
s = pat.sub(lambda m: new_block, s, count=1)
open(cf, "w").write(s)
print("  Caddyfile updated")
PY
sudo caddy validate --config "$CF" --adapter caddyfile >/dev/null && echo "  Caddyfile valid"
sudo systemctl reload caddy && echo "  caddy reloaded"
REMOTE

# --- 6. verify from outside -------------------------------------------------
bold "==> Verify https://labee.online"
sleep 2
curl -s -m 15 -o /dev/null -w "  /                      → %{http_code}\n" https://labee.online/
curl -s -m 15 -w "  /api/auth/providers   → %{http_code}  " https://labee.online/api/auth/providers; echo
curl -s -m 15 -o /dev/null -w "  /api/sessions (401 ok) → %{http_code}\n" https://labee.online/api/sessions
curl -s -m 15 -o /dev/null -w "  /mcp (MCP, 401 ok)     → %{http_code}\n" -X POST https://labee.online/mcp -H 'content-type: application/json' -d '{}'
curl -s -m 15 -o /dev/null -w "  /api/auth/google       → %{http_code} (302 to Google expected)\n" https://labee.online/api/auth/google
bold "==> Done. Sign in at https://labee.online with Google to create your account."
