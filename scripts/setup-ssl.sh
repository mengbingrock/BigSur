#!/usr/bin/env bash
# Add Let's Encrypt TLS to the Labee box (idempotent — safe to re-run).
#
# Runs ON THE SERVER. Invoked by scripts/deploy.sh when DOMAIN + LETSENCRYPT_EMAIL
# are set, or run by hand:
#
#   DOMAIN=labee.online LETSENCRYPT_EMAIL=you@example.com bash scripts/setup-ssl.sh
#
# What it does:
#   1. Installs certbot + the nginx plugin
#   2. Points the labee nginx site at $DOMAIN (HTTP) and reloads
#   3. Obtains/installs a cert with `certbot --nginx --redirect` (certbot owns
#      the 443 server block + the HTTP→HTTPS redirect, and installs a renewal
#      systemd timer)
#   4. Flips COOKIE_SECURE=true in .env.production and restarts labee, so the
#      session cookie is only sent over HTTPS
#   5. Verifies renewal with `certbot renew --dry-run`
#
# Prereqs (do these first; the script checks #1):
#   - $DOMAIN's DNS A record must already point at this box
#   - Lightsail firewall must allow inbound 80 AND 443

set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="${DOMAIN:-}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-}"
SITE=/etc/nginx/sites-available/labee

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m%s\033[0m\n' "  ✓ $*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ -n "$DOMAIN" ] || die "DOMAIN is required (e.g. DOMAIN=labee.online)"
[ -n "$LETSENCRYPT_EMAIL" ] || die "LETSENCRYPT_EMAIL is required (for renewal notices)"

# --- Sanity: does DNS resolve to this box? -------------------------------
bold "[1/5] Checking DNS for $DOMAIN"
resolved="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
myip="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
if [ -n "$resolved" ] && [ -n "$myip" ] && [ "$resolved" != "$myip" ]; then
  printf '\033[33m  ! %s resolves to %s but this box is %s — Let'\''s Encrypt will fail until DNS points here.\033[0m\n' \
    "$DOMAIN" "$resolved" "$myip"
else
  ok "DNS ${resolved:-?} ↔ box ${myip:-?}"
fi

# --- certbot -------------------------------------------------------------
bold "[2/5] Installing certbot + nginx plugin"
if command -v certbot >/dev/null 2>&1; then
  ok "certbot $(certbot --version 2>&1 | awk '{print $2}') already installed"
else
  export DEBIAN_FRONTEND=noninteractive
  sudo apt-get update -qq
  sudo apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  ok "certbot installed"
fi

# --- Point the nginx site at the domain over HTTP ------------------------
bold "[3/5] Configuring nginx server_name=$DOMAIN"
sudo tee "$SITE" >/dev/null <<NGINX
server {
  listen 80;
  listen [::]:80;
  server_name $DOMAIN;

  client_max_body_size 60m;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Connection "";
    # Chat uses Server-Sent Events — disable buffering and allow long streams.
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }
}
NGINX
sudo ln -sf "$SITE" /etc/nginx/sites-enabled/labee
sudo nginx -t >/dev/null 2>&1 || die "nginx config test failed"
sudo systemctl reload nginx
ok "nginx serving HTTP for $DOMAIN"

# --- Obtain + install the certificate ------------------------------------
bold "[4/5] Obtaining Let's Encrypt certificate (certbot --nginx)"
# --redirect rewrites the :80 block to 301 → https and adds the :443 server.
# Re-runs are idempotent: certbot reuses the existing cert if it's still valid.
sudo certbot --nginx \
  -d "$DOMAIN" \
  --non-interactive --agree-tos --redirect \
  -m "$LETSENCRYPT_EMAIL"
ok "certificate installed; HTTP now redirects to HTTPS"

bold "  Verifying auto-renewal"
sudo certbot renew --dry-run >/dev/null 2>&1 && ok "renewal dry-run passed" \
  || printf '\033[33m  ! renewal dry-run failed — check `sudo certbot renew --dry-run`\033[0m\n'

# --- Secure the session cookie now that TLS is in front ------------------
bold "[5/5] Enabling secure cookies"
ENVF="$APP_DIR/.env.production"
if [ -f "$ENVF" ]; then
  if grep -q '^COOKIE_SECURE=' "$ENVF"; then
    sudo sed -i 's/^COOKIE_SECURE=.*/COOKIE_SECURE=true/' "$ENVF"
  else
    echo "COOKIE_SECURE=true" | sudo tee -a "$ENVF" >/dev/null
  fi
  sudo systemctl restart labee
  ok "COOKIE_SECURE=true; labee restarted"
else
  printf '\033[33m  ! %s not found — set COOKIE_SECURE=true manually and restart labee\033[0m\n' "$ENVF"
fi

bold "SSL setup complete → https://$DOMAIN"
