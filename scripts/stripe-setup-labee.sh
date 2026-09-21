#!/usr/bin/env bash
# Create Labee's billing catalog in the Stripe account the Stripe CLI is paired
# with (`stripe login`). Creates one product per plan with a Managed Payments
# eligible tax code, the recurring/one-time prices, and prints the env block to
# paste into /etc/labee.env on the server.
#
#   bash scripts/stripe-setup-labee.sh            # TEST mode (default, safe)
#   bash scripts/stripe-setup-labee.sh --live     # LIVE mode (real money)
#
# Idempotency: Stripe has no natural upsert for products, so this refuses to run
# twice by looking for an existing product with the same lookup metadata. Pass
# --force to create duplicates anyway.
set -euo pipefail

LIVE=0
FORCE=0
for a in "$@"; do
  case "$a" in
    --live) LIVE=1 ;;
    --force) FORCE=1 ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done

TAX_CODE="${STRIPE_TAX_CODE:-txcd_10105001}"   # AI as a Service — cloud
MODE_FLAG=""; MODE_NAME="TEST"; KEY_PREFIX="sk_test"
if [ "$LIVE" = "1" ]; then MODE_FLAG="--live"; MODE_NAME="LIVE"; KEY_PREFIX="sk_live"; fi

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

command -v stripe >/dev/null || die "Stripe CLI not installed"
CFG="$(stripe config --list 2>/dev/null || true)"
grep -qE "(test|live)_mode_api_key|account_id" <<<"$CFG" \
  || die "Stripe CLI is not paired with an account. Run:  stripe login   (then re-run this script)"
ACCT="$(grep -E "^\s*account_id" <<<"$CFG" | head -1 | cut -d"'" -f2 || true)"
bold "==> Creating Labee catalog in $MODE_NAME mode  (tax code $TAX_CODE)"
[ -n "$ACCT" ] && echo "    account: $ACCT"
if [ "$LIVE" = "1" ]; then
  echo
  printf '\033[33m%s\033[0m\n' "LIVE mode: this creates real, purchasable products. Ctrl-C within 5s to abort."
  sleep 5
fi

# The Stripe CLI only accepts --live AFTER the subcommand ("stripe --live
# products list" is parsed as an unknown command), so append it.
api() { stripe "$@" $MODE_FLAG; }

# --live also needs the CLI paired with a live account rather than a sandbox.
if [ "$LIVE" = "1" ]; then
  PROBE="$(stripe products list --limit 1 --live 2>&1 || true)"
  case "$PROBE" in
    *sandbox*) die "the Stripe CLI is paired with a SANDBOX. Run:  stripe switch   and pick the live TrueGrit AI account, then re-run with --live" ;;
  esac
fi

# Refuse to double-create unless forced.
if [ "$FORCE" != "1" ]; then
  EXISTING="$(api products list --limit 100 2>/dev/null | grep -c '"labee_plan"' || true)"
  [ "${EXISTING:-0}" = "0" ] || die "Labee products already exist in this account ($EXISTING). Re-run with --force to add duplicates, or archive the old ones first."
fi

# --- products -------------------------------------------------------------
bold "==> products"
PRO_PRODUCT="$(api products create \
  --name="Labee Pro" \
  --description="Labee Pro subscription" \
  --tax-code="$TAX_CODE" \
  -d "metadata[labee_plan]=pro" \
  2>/dev/null | grep -E '^\s*"id"' | head -1 | cut -d'"' -f4)"
[ -n "$PRO_PRODUCT" ] || die "failed to create the Pro product"
echo "    Pro  $PRO_PRODUCT"

MAX_PRODUCT="$(api products create \
  --name="Labee Max" \
  --description="Labee Max subscription" \
  --tax-code="$TAX_CODE" \
  -d "metadata[labee_plan]=max" \
  2>/dev/null | grep -E '^\s*"id"' | head -1 | cut -d'"' -f4)"
[ -n "$MAX_PRODUCT" ] || die "failed to create the Max product"
echo "    Max  $MAX_PRODUCT"

CREDITS_PRODUCT="$(api products create \
  --name="Labee credits" \
  --description="One-time Labee credit top-up" \
  --tax-code="$TAX_CODE" \
  -d "metadata[labee_plan]=credits" \
  2>/dev/null | grep -E '^\s*"id"' | head -1 | cut -d'"' -f4)"
[ -n "$CREDITS_PRODUCT" ] || die "failed to create the credits product"
echo "    Cred $CREDITS_PRODUCT"

# --- prices ---------------------------------------------------------------
# $1/mo and $10/yr Pro, $20/yr Max, and $10/$25/$50 one-time credit top-ups —
# the structure the previous deployment sold.
price() { # product, cents, [interval]
  local p="$1" cents="$2" interval="${3:-}"
  if [ -n "$interval" ]; then
    api prices create --product="$p" --unit-amount="$cents" --currency=usd \
      -d "recurring[interval]=$interval" 2>/dev/null | grep -E '^\s*"id"' | head -1 | cut -d'"' -f4
  else
    api prices create --product="$p" --unit-amount="$cents" --currency=usd \
      2>/dev/null | grep -E '^\s*"id"' | head -1 | cut -d'"' -f4
  fi
}

bold "==> prices"
PRO_MONTH="$(price "$PRO_PRODUCT" 100 month)";  echo "    Pro  \$1/mo    $PRO_MONTH"
PRO_YEAR="$(price "$PRO_PRODUCT" 1000 year)";   echo "    Pro  \$10/yr   $PRO_YEAR"
MAX_YEAR="$(price "$MAX_PRODUCT" 2000 year)";   echo "    Max  \$20/yr   $MAX_YEAR"
CRED_10="$(price "$CREDITS_PRODUCT" 1000)";     echo "    Cred \$10      $CRED_10"
CRED_25="$(price "$CREDITS_PRODUCT" 2500)";     echo "    Cred \$25      $CRED_25"
CRED_50="$(price "$CREDITS_PRODUCT" 5000)";     echo "    Cred \$50      $CRED_50"

# --- env block ------------------------------------------------------------
echo
bold "==> env block for /etc/labee.env ($MODE_NAME)"
cat <<ENV
STRIPE_SUBSCRIPTION_PRICES=$PRO_MONTH,$PRO_YEAR
STRIPE_SUBSCRIPTION_PRICES_MAX=$MAX_YEAR
# Credit top-ups are a custom-amount flow: the buyer types the amount and the
# server builds an inline priced product, so buildCatalog() skips these fixed
# packs. They are kept for direct /api/billing/checkout calls by price id.
STRIPE_CREDIT_PRICES=$CRED_10,$CRED_25,$CRED_50
STRIPE_MANAGED_PAYMENTS=true
STRIPE_TAX_CODE=$TAX_CODE
LABEE_PUBLIC_URL=https://labee.online
# still needed, from the Dashboard:
#   STRIPE_SECRET_KEY=${KEY_PREFIX}_...
#   STRIPE_WEBHOOK_SECRET=whsec_...   (endpoint: https://labee.online/api/billing/webhook)
ENV
echo
bold "==> next"
cat <<'NEXT'
  1. Create the webhook endpoint (https://labee.online/api/billing/webhook) and
     copy its signing secret:
       stripe webhook_endpoints create \
         --url https://labee.online/api/billing/webhook \
         --enabled-events checkout.session.completed \
         --enabled-events customer.subscription.created \
         --enabled-events customer.subscription.updated \
         --enabled-events customer.subscription.deleted \
         [--live]        # note: --live goes LAST, the CLI rejects it up front
  2. Put the env block plus the secret key and webhook secret into
     /etc/labee.env on the server, then: sudo systemctl restart labee
  3. Test the flow locally against test mode:
       stripe listen --forward-to localhost:3000/api/billing/webhook
NEXT
