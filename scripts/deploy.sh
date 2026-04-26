#!/usr/bin/env bash
# Deploy Monterey to a Lightsail / Ubuntu box.
#
# Usage:
#   ./scripts/deploy.sh                  # uses defaults below
#   SSH_HOST=1.2.3.4 ./scripts/deploy.sh # override host
#
# Defaults target the box we packed for:
#   SSH_HOST=34.211.225.249
#   SSH_USER=ubuntu
#   SSH_KEY=$HOME/Downloads/lightsail.pem
#   REMOTE_DIR=/home/ubuntu/agent-monterey
#
# Requires: rsync, ssh, an SSH key that can log into SSH_HOST.
#
# What it does:
#   1. Sanity-checks SSH + key perms
#   2. rsyncs the project to the server (excluding node_modules, .next, data, .git)
#   3. Runs scripts/provision-server.sh on the server (one-time install of
#      node / claude CLI / swap / systemd unit)
#   4. Runs scripts/build-and-restart.sh on the server (idempotent; fine to
#      run on repeat deploys too)
#
# It does NOT:
#   - Authenticate the claude CLI (you do that once from the server shell)
#   - Open the Lightsail firewall (do that in the AWS console)

set -euo pipefail

# --- Config ---------------------------------------------------------------
SSH_HOST="${SSH_HOST:-34.211.225.249}"
SSH_USER="${SSH_USER:-ubuntu}"
SSH_KEY="${SSH_KEY:-$HOME/Downloads/lightsail.pem}"
REMOTE_DIR="${REMOTE_DIR:-/home/ubuntu/agent-monterey}"
REMOTE_SKILLS_DIR="${REMOTE_SKILLS_DIR:-/home/ubuntu/protocol-skills}"
REMOTE_DECK_DIR="${REMOTE_DECK_DIR:-/home/ubuntu/monterey-decks}"
LOCAL_SKILLS_DIR="${LOCAL_SKILLS_DIR:-$HOME/WorkSync/Git/protocol-agent/.claude/skills}"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# --- Pre-flight -----------------------------------------------------------
[ -f "$SSH_KEY" ] || die "SSH key not found: $SSH_KEY"

perms="$(stat -f %A "$SSH_KEY" 2>/dev/null || stat -c %a "$SSH_KEY")"
if [ "$perms" != "400" ] && [ "$perms" != "600" ]; then
  warn "Tightening $SSH_KEY permissions to 0400"
  chmod 400 "$SSH_KEY"
fi

SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 $SSH_USER@$SSH_HOST"
RSYNC_SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15"

bold "==> Testing SSH to $SSH_USER@$SSH_HOST"
$SSH 'echo "ok, host: $(hostname)"' || die "SSH failed — see stderr"

# --- Sync app code --------------------------------------------------------
bold "==> rsync app code → $REMOTE_DIR"
$SSH "mkdir -p $REMOTE_DIR"
rsync -az --delete \
  --exclude='node_modules' \
  --exclude='.next' \
  --exclude='out' \
  --exclude='.git' \
  --exclude='data' \
  --exclude='.env*' \
  --exclude='*.log' \
  --exclude='.DS_Store' \
  -e "$RSYNC_SSH" \
  "$PROJECT_ROOT/" "$SSH_USER@$SSH_HOST:$REMOTE_DIR/"

# --- Sync skills ----------------------------------------------------------
if [ -d "$LOCAL_SKILLS_DIR" ]; then
  bold "==> rsync skills ($LOCAL_SKILLS_DIR) → $REMOTE_SKILLS_DIR"
  $SSH "mkdir -p $REMOTE_SKILLS_DIR"
  rsync -azL --delete \
    --exclude='.DS_Store' \
    -e "$RSYNC_SSH" \
    "$LOCAL_SKILLS_DIR/" "$SSH_USER@$SSH_HOST:$REMOTE_SKILLS_DIR/"
else
  warn "Skills dir not found: $LOCAL_SKILLS_DIR (skipping)"
  warn "Set LOCAL_SKILLS_DIR or ignore if you don't want any default skills."
fi

# --- Provision + build ----------------------------------------------------
bold "==> First-time provisioning (idempotent)"
$SSH "SKILLS_ROOT=$REMOTE_SKILLS_DIR DECK_ROOT=$REMOTE_DECK_DIR bash $REMOTE_DIR/scripts/provision-server.sh"

bold "==> Build + restart service"
$SSH "SKILLS_ROOT=$REMOTE_SKILLS_DIR DECK_ROOT=$REMOTE_DECK_DIR bash $REMOTE_DIR/scripts/build-and-restart.sh"

# --- Post-flight ----------------------------------------------------------
echo
bold "==> Deploy complete."
cat <<EOF

Next steps (one-time):

  1. Log in to the Claude CLI on the server (requires a Claude subscription):
       ssh -i $SSH_KEY $SSH_USER@$SSH_HOST
       claude /login          # or: claude setup-token
     Follow the prompts. OAuth creds are stored in ~/.claude/ on the box.

  2. Open port 3000 in the Lightsail firewall (AWS console → instance →
     Networking → Add rule → Custom TCP 3000, restricted to your IP if
     possible).

  3. Create your first admin account (public signup is disabled by default):
       ssh -i $SSH_KEY $SSH_USER@$SSH_HOST
       cd $REMOTE_DIR
       npm run user create you@example.com --admin

  4. Open http://$SSH_HOST:3000 in a browser, sign in.

     ⚠️  HTTP only — passwords travel in cleartext. For anything beyond
         a personal test, add HTTPS (see DEPLOY.md).

Check service status any time with:
  ssh -i $SSH_KEY $SSH_USER@$SSH_HOST 'sudo systemctl status monterey --no-pager; sudo journalctl -u monterey -n 30 --no-pager'
EOF
