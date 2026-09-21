#!/usr/bin/env bash
# Verify Labee's own billing code against Stripe TEST mode end to end:
# boots the server with the test catalog, asks it to start a checkout for each
# configured plan, and asserts Stripe recorded the session as Managed Payments.
#
# Requires a test secret key in scripts/.stripe-test.env (gitignored):
#   STRIPE_SECRET_KEY=sk_test_...
# Get it from https://dashboard.stripe.com/test/apikeys and write it with:
#   printf 'STRIPE_SECRET_KEY=%s\n' "sk_test_..." > scripts/.stripe-test.env
#
#   bash scripts/stripe-verify-local.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEYFILE="$ROOT/scripts/.stripe-test.env"
EMAIL="${LABEE_TEST_EMAIL:-billing-test@example.com}"
SESSION_PASSWORD="verify-password-at-least-32-chars-long!!"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$KEYFILE" ] || die "missing $KEYFILE — see the header of this script"
# shellcheck disable=SC1090
set -a; . "$KEYFILE"; set +a
[ -n "${STRIPE_SECRET_KEY:-}" ] || die "STRIPE_SECRET_KEY not set in $KEYFILE"
case "$STRIPE_SECRET_KEY" in sk_test_*|rk_test_*) ;; *) die "refusing to run: key is not a TEST key" ;; esac

# Test-mode price IDs created by scripts/stripe-setup-labee.sh.
: "${STRIPE_SUBSCRIPTION_PRICES:=price_1UI0yQCrjFrlxp6fc63y5uig,price_1UI0yQCrjFrlxp6fFI6SfkvR}"
: "${STRIPE_SUBSCRIPTION_PRICES_MAX:=price_1UI0yRCrjFrlxp6fCKQKOJ2I}"
: "${STRIPE_CREDIT_PRICES:=price_1UI0yRCrjFrlxp6ffWgXStxF,price_1UI0ySCrjFrlxp6fmqjkJNaD,price_1UI0ySCrjFrlxp6fnXphFE74}"

# process.stdout.write, not console.log: console.log runs a number through
# util.inspect, which wraps it in yellow ANSI escapes. Those escapes end up
# inside LABEE_PUBLIC_URL and Stripe rejects the success_url as "Not a valid URL".
PORT="$(node -e 's=require("net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')"
TMP="$(mktemp -d)"
SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  [ -n "$SERVER_PID" ] && pkill -P "$SERVER_PID" 2>/dev/null
  rm -rf "$TMP"
  return 0
}
trap cleanup EXIT

bold "==> booting Labee server on :$PORT with the TEST catalog"
(
  cd "$ROOT/apps/server"
  # exec so $! below is the bun process itself and the trap can actually kill it.
  # Without this the subshell exits first and bun is orphaned, and the next run's
  # requests land on the stale server instead of the fresh one.
  LABEE_PORT="$PORT" LABEE_HOST=127.0.0.1 \
  LABEE_DATA_DIR="$TMP/data" DECK_ROOT="$TMP/decks" SKILLS_ROOTS="$TMP/skills" \
  SESSION_PASSWORD="$SESSION_PASSWORD" COOKIE_SECURE=false \
  STRIPE_SECRET_KEY="$STRIPE_SECRET_KEY" \
  STRIPE_SUBSCRIPTION_PRICES="$STRIPE_SUBSCRIPTION_PRICES" \
  STRIPE_SUBSCRIPTION_PRICES_MAX="$STRIPE_SUBSCRIPTION_PRICES_MAX" \
  STRIPE_CREDIT_PRICES="$STRIPE_CREDIT_PRICES" \
  STRIPE_MANAGED_PAYMENTS=true \
  LABEE_PUBLIC_URL="http://127.0.0.1:$PORT" \
  exec bun run src/bin.ts
) > "$TMP/server.log" 2>&1 &
SERVER_PID=$!

# The server must come up on the port we asked for: LABEE_PUBLIC_URL (and so the
# Stripe success/cancel URLs) was baked with it, and talking to a different port
# would mean we are testing somebody else's process.
for _ in $(seq 1 60); do
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/me" && break
  kill -0 "$SERVER_PID" 2>/dev/null || { cat "$TMP/server.log"; die "server exited during startup"; }
  sleep 0.5
done
curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/me" || { tail -30 "$TMP/server.log"; die "server did not start on :$PORT"; }
echo "    up on :$PORT (pid $SERVER_PID)"

COOKIE="monterey_session=$(cd "$ROOT/apps/server" && SESSION_PASSWORD="$SESSION_PASSWORD" bun -e '
  import { sealSession } from "./src/services/session";
  console.log(encodeURIComponent(await sealSession({ email: process.argv[1], isAdmin: true })));
' "$EMAIL")"

bold "==> catalog the server advertises (GET /api/billing)"
curl -s -H "cookie: $COOKIE" "http://127.0.0.1:$PORT/api/billing" | python3 -c '
import json, sys
d = json.load(sys.stdin)
if not d.get("configured"):
    print("    billing reports configured=false - the secret key did not reach the server")
items = d.get("catalog") or []
for p in items:
    amount = p.get("amount")
    money = "$%.2f" % (amount / 100) if isinstance(amount, int) else "?"
    every = p.get("interval") or "one-time"
    print("    %-12s %-34s %-8s %-9s %s" % (
        p.get("kind", "?"), p.get("id", ""), money, every, p.get("label", "")))
if not items:
    print("    (empty catalog - check the price IDs / secret key)")
    sys.exit(1)
' || die "catalog check failed"

bold "==> starting a checkout for each plan and checking Managed Payments"
FAIL=0
for PRICE in $(echo "$STRIPE_SUBSCRIPTION_PRICES,$STRIPE_SUBSCRIPTION_PRICES_MAX,$STRIPE_CREDIT_PRICES" | tr ',' ' '); do
  BODY="$(curl -s -X POST -H "cookie: $COOKIE" -H 'content-type: application/json' \
      -d "{\"productId\":\"$PRICE\"}" "http://127.0.0.1:$PORT/api/billing/checkout")"
  URL="$(printf '%s' "$BODY" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("url") or "")
except Exception: print("")')"
  case "$URL" in
    https://checkout.stripe.com/*)
      CS="$(printf '%s' "$URL" | sed -E 's#.*/c/pay/(cs_test_[^#]*).*#\1#')"
      MP="$(stripe get "/v1/checkout/sessions/$CS" 2>/dev/null \
            | python3 -c 'import json,sys; print((json.load(sys.stdin).get("managed_payments") or {}).get("enabled"))' 2>/dev/null)"
      if [ "$MP" = "True" ]; then printf '    \033[32m✓\033[0m %s  managed_payments=on\n' "$PRICE"
      else printf '    \033[31m✗\033[0m %s  managed_payments=%s\n' "$PRICE" "$MP"; FAIL=1; fi
      ;;
    *) printf '    \033[31m✗\033[0m %s  checkout failed: %s\n' "$PRICE" "$(printf '%s' "$BODY" | head -c 300)"; FAIL=1 ;;
  esac
done

echo
[ "$FAIL" = "0" ] && bold "==> PASS — every plan checks out as Managed Payments" \
                  || { bold "==> FAIL — see above"; tail -30 "$TMP/server.log"; exit 1; }
