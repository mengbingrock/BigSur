#!/usr/bin/env bash
# Provision an Ubuntu box for Labee. Idempotent — safe to re-run.
#
# Runs ON THE SERVER, invoked by scripts/deploy.sh. Don't run this from your
# laptop.
#
# Installs:
#   - 1 GB swap file (the Lightsail "nano" plan has 512 MB RAM; Next.js
#     builds OOM without swap)
#   - Node.js 20 via NodeSource
#   - python3-pip + LibreOffice (needed by some Anthropic skills like docx)
#   - @anthropic-ai/claude-code globally
#   - systemd unit for the app
#   - .env.production with a random SESSION_PASSWORD and SIGNUP_ENABLED=false
#
# Env vars (set by deploy.sh):
#   SKILLS_ROOT   absolute path to the symlink-target skills dir on the server
#   DECK_ROOT     absolute path to the per-user deck root on the server

set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS_ROOT="${SKILLS_ROOT:-}"
DECK_ROOT="${DECK_ROOT:-}"

# ~/.local/bin isn't on PATH for non-interactive SSH sessions on Ubuntu 24.04.
# The native `claude` installer symlinks here, so make sure we can see it.
export PATH="$HOME/.local/bin:$PATH"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m%s\033[0m\n' "  ✓ $*"; }
skip() { printf '\033[90m%s\033[0m\n' "  - $*"; }

# --- Swap ----------------------------------------------------------------
bold "[1/6] Ensuring 1 GB swap exists"
if [ -f /swapfile ] && swapon --show | grep -q /swapfile; then
  skip "swap already active"
else
  sudo fallocate -l 1G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  if ! grep -q '^/swapfile' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  fi
  ok "swap enabled"
fi

# --- Apt packages --------------------------------------------------------
bold "[2/6] Installing apt packages"
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get install -y -qq \
  curl ca-certificates gnupg \
  build-essential \
  python3 python3-pip python3-venv \
  libreoffice-core libreoffice-writer libreoffice-calc \
  >/dev/null
ok "apt packages installed"

# --- Node.js 20 ----------------------------------------------------------
bold "[3/6] Ensuring Node.js 24 + Bun"
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -v | sed 's/^v//;s/\..*//')
else
  NODE_MAJOR=0
fi
if [ "$NODE_MAJOR" -ge 24 ]; then
  skip "Node $(node -v) already installed"
else
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - >/dev/null 2>&1
  sudo apt-get install -y -qq nodejs >/dev/null
  ok "installed Node $(node -v)"
fi
if command -v bun >/dev/null 2>&1 || [ -x "$HOME/.bun/bin/bun" ]; then
  skip "Bun already installed"
else
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
  ok "installed Bun"
fi
export PATH="$HOME/.bun/bin:$PATH"

# --- Claude CLI ----------------------------------------------------------
bold "[4/6] Installing @anthropic-ai/claude-code"
if command -v claude >/dev/null 2>&1; then
  skip "claude $(claude --version 2>/dev/null | head -1) already installed"
else
  sudo npm install -g @anthropic-ai/claude-code >/dev/null 2>&1
  ok "claude installed: $(claude --version 2>/dev/null | head -1)"
fi

# --- .env.production -----------------------------------------------------
bold "[5/6] Ensuring .env.production"
if [ -f "$APP_DIR/.env.production" ]; then
  skip ".env.production already exists — leaving as-is"
  # Append DECK_ROOT if missing (existing install upgrading to deck feature).
  if [ -n "$DECK_ROOT" ] && ! grep -q '^DECK_ROOT=' "$APP_DIR/.env.production"; then
    echo "DECK_ROOT=$DECK_ROOT" >> "$APP_DIR/.env.production"
    ok "appended DECK_ROOT to existing .env.production"
  fi
else
  SESSION_PASSWORD="$(openssl rand -base64 48 | tr -d '\n' | tr '/+' '_-' | cut -c1-48)"
  {
    echo "NODE_ENV=production"
    echo "PORT=3000"
    echo "SESSION_PASSWORD=$SESSION_PASSWORD"
    echo "SIGNUP_ENABLED=false"
    # We currently serve HTTP only. Secure cookies don't land on HTTP; flip
    # this to true once TLS is in front of the app (Cloudflare Tunnel, nginx+
    # certbot, or ALB).
    echo "COOKIE_SECURE=false"
    if [ -n "$SKILLS_ROOT" ]; then
      echo "SKILLS_ROOTS=$SKILLS_ROOT"
    fi
    if [ -n "$DECK_ROOT" ]; then
      echo "DECK_ROOT=$DECK_ROOT"
    fi
  } > "$APP_DIR/.env.production"
  chmod 600 "$APP_DIR/.env.production"
  ok "wrote $APP_DIR/.env.production"
fi

# Bootstrap the deck dir (separate from skills; not touched by rsync).
if [ -n "$DECK_ROOT" ]; then
  mkdir -p "$DECK_ROOT"
  ok "deck root ready at $DECK_ROOT"
fi

# --- systemd unit --------------------------------------------------------
bold "[6/6] Installing systemd unit"
UNIT_PATH=/etc/systemd/system/labee.service
if [ ! -f "$UNIT_PATH" ] || ! diff -q "$APP_DIR/scripts/labee.service" "$UNIT_PATH" >/dev/null 2>&1; then
  sudo cp "$APP_DIR/scripts/labee.service" "$UNIT_PATH"
  sudo systemctl daemon-reload
  sudo systemctl enable labee >/dev/null 2>&1
  ok "systemd unit installed + enabled"
else
  skip "systemd unit up to date"
fi

bold "Provisioning complete."
