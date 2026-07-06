// Stripe-backed billing: hosted Checkout for recurring subscriptions and
// one-time credit top-ups, a customer-portal link, and a webhook handler that
// reconciles the local `billing` table from Stripe events.
//
// Config (all via env; absent STRIPE_SECRET_KEY = billing disabled):
//   STRIPE_SECRET_KEY         sk_live_… / sk_test_…
//   STRIPE_WEBHOOK_SECRET     whsec_… (Stripe → webhook signing secret)
//   STRIPE_PRICE_PRO          recurring price id → grants the "pro" plan
//   STRIPE_PRICE_MAX          recurring price id → grants the "max" plan
//   STRIPE_PRICE_CREDITS_10   one-time price id → credit top-up
//   STRIPE_PRICE_CREDITS_25   one-time price id → credit top-up
//   STRIPE_PRICE_CREDITS_50   one-time price id → credit top-up
//   LABEE_PUBLIC_URL          (optional) absolute app URL for Checkout returns
import Stripe from "stripe";
import {
  CUSTOM_CREDITS_PRODUCT_ID,
  MIN_TOPUP_CENTS,
  type BillingProduct,
  type BillingState,
  type PlanTier,
  type RedeemResult,
  type UsageEvent,
  type UsageSummary,
} from "@labee/contracts";
import { getDb } from "./db";
import { priceUsage } from "./pricing";
import { findUser } from "./users";

const CURRENCY = "usd";

/** Local subscription_status marker for a complimentary (coupon-granted) plan —
 *  distinguishes it from a real Stripe subscription. */
const COMPED = "comped";

/** Parse a non-negative integer env var, falling back to a default. */
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Starting balance (cents) granted once to every new account. $20 by default;
 *  override with LABEE_SIGNUP_CREDITS (0 disables the grant). */
export function signupGrantCents(): number {
  return intEnv("LABEE_SIGNUP_CREDITS", 2000);
}

/** The usage-credit allowance (cents) a paid plan grants per billing period.
 *  Pro = $20, Max = $100 by default; override with LABEE_PLAN_CREDITS_PRO /
 *  LABEE_PLAN_CREDITS_MAX. */
export function planCreditCents(plan: PlanTier): number {
  if (plan === "max") return intEnv("LABEE_PLAN_CREDITS_MAX", 10000);
  if (plan === "pro") return intEnv("LABEE_PLAN_CREDITS_PRO", 2000);
  return 0;
}

// ── Coupons ──────────────────────────────────────────────────────────────────

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

/** The set of valid coupon codes (normalized), from LABEE_COUPON_CODES
 *  (comma-separated). Empty = coupons disabled. */
function couponCodes(): Set<string> {
  return new Set(
    (process.env.LABEE_COUPON_CODES ?? "")
      .split(",")
      .map((c) => normalizeCode(c))
      .filter(Boolean),
  );
}

/** Months of Pro a coupon grants (LABEE_COUPON_MONTHS, default 3). */
function couponMonths(): number {
  const n = Number.parseInt(process.env.LABEE_COUPON_MONTHS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

/** Whether a billing row is a currently-active complimentary plan. */
function compActive(row: BillingRow | null): boolean {
  if (!row || row.subscription_status !== COMPED || !row.current_period_end) return false;
  const end = Date.parse(row.current_period_end);
  return Number.isFinite(end) && end > Date.now();
}

interface BillingRow {
  email: string;
  customer_id: string | null;
  plan: string;
  subscription_id: string | null;
  subscription_status: string | null;
  current_period_end: string | null;
  cancel_at_period_end: number;
  credits: number;
  /** The subscription period end we last granted the plan credit allowance for
   *  — guards against re-granting on duplicate webhooks within a period. */
  credited_period: string | null;
  /** Stripe price id of the active subscription (which exact price/interval). */
  subscription_price_id: string | null;
  updated_at: string;
}

// The catalog is driven by Stripe price IDs from env; display metadata (name,
// amount, interval) is fetched live from Stripe so it always matches the
// account. Configure with comma-separated price IDs:
//   STRIPE_SUBSCRIPTION_PRICES        recurring price IDs → "pro" plan
//   STRIPE_SUBSCRIPTION_PRICES_MAX    recurring price IDs → "max" plan (optional)
//   STRIPE_CREDIT_PRICES              one-time price IDs (fixed or pay-what-you-want)
// Back-compat: STRIPE_PRICE_PRO / STRIPE_PRICE_MAX / STRIPE_PRICE_CREDITS_* are
// used when the *_PRICES lists above are absent.
interface PriceRef {
  priceId: string;
  kind: "subscription" | "credits";
  plan?: PlanTier;
}

function csv(v: string | undefined): string[] {
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

/** Global free-trial length (days) applied to subscription checkouts that don't
 *  already carry a trial on the Stripe price. 0 = no global trial. */
function globalTrialDays(): number {
  const n = Number.parseInt(process.env.STRIPE_TRIAL_DAYS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Effective trial days for a subscription price: the price's own trial, else
 *  the global env default. */
function trialDaysFor(price: Stripe.Price | null): number {
  return price?.recurring?.trial_period_days ?? globalTrialDays();
}

/** The configured price references (no Stripe call — just env). */
function configuredPrices(): PriceRef[] {
  const out: PriceRef[] = [];
  const subPro = csv(process.env.STRIPE_SUBSCRIPTION_PRICES);
  const subMax = csv(process.env.STRIPE_SUBSCRIPTION_PRICES_MAX);
  if (subPro.length || subMax.length) {
    for (const p of subPro) out.push({ priceId: p, kind: "subscription", plan: "pro" });
    for (const p of subMax) out.push({ priceId: p, kind: "subscription", plan: "max" });
  } else {
    if (process.env.STRIPE_PRICE_PRO)
      out.push({ priceId: process.env.STRIPE_PRICE_PRO, kind: "subscription", plan: "pro" });
    if (process.env.STRIPE_PRICE_MAX)
      out.push({ priceId: process.env.STRIPE_PRICE_MAX, kind: "subscription", plan: "max" });
  }
  const creditList = csv(process.env.STRIPE_CREDIT_PRICES);
  const credits = creditList.length
    ? creditList
    : ["STRIPE_PRICE_CREDITS_10", "STRIPE_PRICE_CREDITS_25", "STRIPE_PRICE_CREDITS_50"]
        .map((v) => process.env[v])
        .filter((v): v is string => Boolean(v));
  for (const p of credits) out.push({ priceId: p, kind: "credits" });
  return out;
}

// ── Stripe client ───────────────────────────────────────────────────────────

let stripeClient: Stripe | null = null;

/** The Stripe client, or null when STRIPE_SECRET_KEY isn't configured. */
export function stripe(): Stripe | null {
  if (stripeClient) return stripeClient;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  stripeClient = new Stripe(key, { appInfo: { name: "Labee" } });
  return stripeClient;
}

export function billingConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

function invalid(message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = "INVALID";
  return e;
}

function requireStripe(): Stripe {
  const s = stripe();
  if (!s) throw invalid("Billing is not configured on this server.");
  return s;
}

// Short-lived cache of fetched prices so GET /api/billing doesn't hit Stripe
// on every request.
const priceCache = new Map<string, { price: Stripe.Price; at: number }>();
const PRICE_TTL_MS = 5 * 60 * 1000;

async function fetchPrice(id: string): Promise<Stripe.Price | null> {
  const cached = priceCache.get(id);
  if (cached && Date.now() - cached.at < PRICE_TTL_MS) return cached.price;
  const s = stripe();
  if (!s) return null;
  try {
    const price = await s.prices.retrieve(id, { expand: ["product"] });
    priceCache.set(id, { price, at: Date.now() });
    return price;
  } catch {
    return null; // unknown id / wrong mode / inactive — skip it
  }
}

/** Build the purchasable catalog from the configured price IDs, fetching each
 *  price's display metadata (name/amount/interval) live from Stripe. */
async function buildCatalog(): Promise<BillingProduct[]> {
  if (!billingConfigured()) return [];
  const out: BillingProduct[] = [];
  for (const ref of configuredPrices()) {
    // Credit top-ups are now a custom-amount flow (the buyer types the amount),
    // so fixed credit packs aren't advertised in the catalog anymore.
    if (ref.kind === "credits") continue;
    const price = await fetchPrice(ref.priceId);
    if (!price || price.active === false) continue;
    const product =
      price.product && typeof price.product === "object" && !("deleted" in price.product)
        ? (price.product as Stripe.Product)
        : null;
    // A price with custom_unit_amount lets the buyer choose the amount at Checkout.
    const customAmount = price.unit_amount == null && Boolean(price.custom_unit_amount);
    const trialDays = ref.kind === "subscription" ? trialDaysFor(price) : 0;
    out.push({
      id: price.id,
      kind: ref.kind,
      label: product?.name ?? (ref.kind === "subscription" ? "Subscription" : "Credits"),
      description: product?.description ?? "",
      amount: price.unit_amount ?? 0,
      currency: price.currency ?? CURRENCY,
      ...(price.recurring?.interval ? { interval: price.recurring.interval } : {}),
      ...(ref.plan ? { plan: ref.plan } : {}),
      ...(customAmount ? { customAmount: true } : {}),
      ...(trialDays > 0 ? { trialDays } : {}),
    });
  }
  return out;
}

/** Map a Stripe (subscription) price id back to the plan it grants. */
function planForPriceId(priceId: string | null | undefined): PlanTier | null {
  if (!priceId) return null;
  const ref = configuredPrices().find((r) => r.priceId === priceId && r.kind === "subscription");
  return ref?.plan ?? null;
}

// ── Local billing row ───────────────────────────────────────────────────────

async function readRow(email: string): Promise<BillingRow | null> {
  const db = await getDb();
  const row = db.prepare("SELECT * FROM billing WHERE email = ?").get(email);
  return (row as BillingRow | undefined) ?? null;
}

async function upsert(email: string, patch: Partial<Omit<BillingRow, "email">>): Promise<void> {
  const db = await getDb();
  const existing = await readRow(email);
  const next: Omit<BillingRow, "email"> = {
    customer_id: patch.customer_id ?? existing?.customer_id ?? null,
    plan: patch.plan ?? existing?.plan ?? "free",
    subscription_id: patch.subscription_id ?? existing?.subscription_id ?? null,
    subscription_status: patch.subscription_status ?? existing?.subscription_status ?? null,
    current_period_end: patch.current_period_end ?? existing?.current_period_end ?? null,
    cancel_at_period_end: patch.cancel_at_period_end ?? existing?.cancel_at_period_end ?? 0,
    credits: patch.credits ?? existing?.credits ?? 0,
    credited_period: patch.credited_period ?? existing?.credited_period ?? null,
    subscription_price_id: patch.subscription_price_id ?? existing?.subscription_price_id ?? null,
    updated_at: new Date().toISOString(),
  };
  db.prepare(
    "INSERT INTO billing (email, customer_id, plan, subscription_id, subscription_status, " +
      "current_period_end, cancel_at_period_end, credits, credited_period, subscription_price_id, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(email) DO UPDATE SET " +
      "customer_id = excluded.customer_id, plan = excluded.plan, " +
      "subscription_id = excluded.subscription_id, subscription_status = excluded.subscription_status, " +
      "current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end, " +
      "credits = excluded.credits, credited_period = excluded.credited_period, " +
      "subscription_price_id = excluded.subscription_price_id, updated_at = excluded.updated_at",
  ).run(
    email,
    next.customer_id,
    next.plan,
    next.subscription_id,
    next.subscription_status,
    next.current_period_end,
    next.cancel_at_period_end,
    next.credits,
    next.credited_period,
    next.subscription_price_id,
    next.updated_at,
  );
}

function coercePlan(v: string | undefined | null): PlanTier {
  return v === "pro" || v === "max" ? v : "free";
}

// ── Public read API ─────────────────────────────────────────────────────────

/** The user's billing state + the purchasable catalog (GET /api/billing). */
export async function getBillingState(email: string): Promise<BillingState> {
  await grantSignupCredits(email); // first touch provisions the $20 starting balance
  const row = await readRow(email);
  const products = await buildCatalog();
  // An expired complimentary plan reads back as free (the row is only rewritten
  // on the next redeem/purchase — the effective state is computed here).
  const comped = row?.subscription_status === COMPED;
  const compExpired = comped && !compActive(row);
  const subActive =
    row?.subscription_status === "active" || row?.subscription_status === "trialing";

  // The exact purchased price (so the UI marks only that card current, not the
  // whole plan tier). Backfill from Stripe for subscriptions created before we
  // started storing it — a one-time retrieve, then it's persisted.
  let subscriptionPriceId = row?.subscription_price_id ?? null;
  if (!subscriptionPriceId && subActive && row?.subscription_id) {
    try {
      const s = stripe();
      if (s) {
        const sub = await s.subscriptions.retrieve(row.subscription_id);
        subscriptionPriceId = sub.items.data[0]?.price?.id ?? null;
        if (subscriptionPriceId) await upsert(email, { subscription_price_id: subscriptionPriceId });
      }
    } catch {
      // couldn't backfill — leave null; UI just won't mark a card current
    }
  }

  return {
    configured: billingConfigured(),
    plan: compExpired ? "free" : coercePlan(row?.plan),
    subscriptionStatus: compExpired ? "expired" : row?.subscription_status ?? null,
    subscriptionPriceId: compExpired ? null : subscriptionPriceId,
    currentPeriodEnd: row?.current_period_end ?? null,
    cancelAtPeriodEnd: Boolean(row?.cancel_at_period_end),
    credits: row?.credits ?? 0,
    spent: await getSpent(email),
    signupGrant: signupGrantCents(),
    currency: CURRENCY,
    canManage: Boolean(row?.customer_id),
    catalog: products,
  };
}

/** Credit balance in cents. */
export async function getCredits(email: string): Promise<number> {
  return (await readRow(email))?.credits ?? 0;
}

// ── Credit ledger ────────────────────────────────────────────────────────────

type LedgerKind = "grant" | "spend" | "topup" | "subscription" | "adjustment";

interface LedgerEntry {
  kind: LedgerKind;
  /** Signed change to the balance in cents (spend is negative). */
  amount: number;
  provider?: string | null;
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
}

/** Append an itemised ledger row (the audit trail behind billing.credits). */
async function ledger(email: string, e: LedgerEntry): Promise<void> {
  const db = await getDb();
  db.prepare(
    "INSERT INTO usage_events (email, kind, amount_cents, provider, model, input_tokens, output_tokens, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    email,
    e.kind,
    Math.round(e.amount),
    e.provider ?? null,
    e.model ?? null,
    Math.round(e.inputTokens ?? 0),
    Math.round(e.outputTokens ?? 0),
    new Date().toISOString(),
  );
}

/** Grant the one-time signup balance if this account has no billing row yet.
 *  Idempotent — a second call for the same account is a no-op. Returns the
 *  cents granted (0 when already provisioned or the grant is disabled). */
export async function grantSignupCredits(email: string): Promise<number> {
  if (await readRow(email)) return 0; // already provisioned
  const cents = signupGrantCents();
  await upsert(email, { credits: cents });
  if (cents > 0) await ledger(email, { kind: "grant", amount: cents });
  return cents;
}

/** Add credits (cents) to the user's balance (Stripe top-up / subscription). */
export async function addCredits(
  email: string,
  cents: number,
  kind: Extract<LedgerKind, "topup" | "subscription" | "adjustment"> = "topup",
): Promise<void> {
  if (cents <= 0) return;
  const current = await getCredits(email);
  await upsert(email, { credits: current + Math.round(cents) });
  await ledger(email, { kind, amount: Math.round(cents) });
}

/** Debit credits if the balance covers it; returns false when it doesn't. */
export async function consumeCredits(email: string, cents: number): Promise<boolean> {
  if (cents <= 0) return true;
  const current = await getCredits(email);
  if (current < cents) return false;
  await upsert(email, { credits: current - Math.round(cents) });
  return true;
}

/** Meter a completed Provided-inference call: price the tokens, debit the
 *  balance (never below zero), and append a spend ledger row. Best-effort —
 *  never throws into the request path. Returns the cents charged. */
export async function recordUsage(input: {
  email: string;
  provider: "anthropic" | "openai";
  model: string | null;
  inputTokens: number;
  outputTokens: number;
}): Promise<number> {
  const cents = Math.round(priceUsage(input.model, input.inputTokens, input.outputTokens));
  if (cents <= 0 && input.inputTokens + input.outputTokens === 0) return 0;
  try {
    const current = await getCredits(input.email);
    await upsert(input.email, { credits: Math.max(0, current - cents) });
    await ledger(input.email, {
      kind: "spend",
      amount: -cents,
      provider: input.provider,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
    });
  } catch {
    // metering must never break inference — swallow and move on
  }
  return cents;
}

/** Lifetime spend (cents) — sum of the magnitudes of spend ledger rows. */
async function getSpent(email: string): Promise<number> {
  const db = await getDb();
  const row = db
    .prepare("SELECT COALESCE(-SUM(amount_cents), 0) AS spent FROM usage_events WHERE email = ? AND kind = 'spend'")
    .get(email) as { spent: number } | undefined;
  return Math.max(0, Number(row?.spent ?? 0));
}

/** Spend summary + recent ledger for the account (GET /api/billing/usage). */
export async function getUsageSummary(email: string, limit = 50): Promise<UsageSummary> {
  await grantSignupCredits(email); // provision the starting balance on first view
  const db = await getDb();
  const rows = db
    .prepare(
      "SELECT id, kind, amount_cents, provider, model, input_tokens, output_tokens, created_at " +
        "FROM usage_events WHERE email = ? ORDER BY id DESC LIMIT ?",
    )
    .all(email, limit) as Array<{
    id: number;
    kind: string;
    amount_cents: number;
    provider: string | null;
    model: string | null;
    input_tokens: number;
    output_tokens: number;
    created_at: string;
  }>;
  const granted = db
    .prepare(
      "SELECT COALESCE(SUM(amount_cents), 0) AS g FROM usage_events WHERE email = ? AND kind IN ('grant','topup','subscription')",
    )
    .get(email) as { g: number } | undefined;
  const events: UsageEvent[] = rows.map((r) => ({
    id: Number(r.id),
    kind: (["grant", "spend", "topup", "subscription", "adjustment"].includes(r.kind)
      ? r.kind
      : "adjustment") as UsageEvent["kind"],
    amount: Number(r.amount_cents),
    provider: r.provider,
    model: r.model,
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    createdAt: r.created_at,
  }));
  return {
    balance: await getCredits(email),
    granted: Math.max(0, Number(granted?.g ?? 0)),
    spent: await getSpent(email),
    currency: CURRENCY,
    events,
  };
}

/** True when the user has an active paid plan or a positive credit balance.
 *  Admins (the account owner / team) are always entitled — they run on Labee's
 *  own account without needing to purchase a plan. */
export async function hasPaidEntitlement(email: string): Promise<boolean> {
  const user = await findUser(email);
  if (user?.isAdmin) return true;
  await grantSignupCredits(email); // provision the starting balance on first use
  const row = await readRow(email);
  if (!row) return false;
  if (compActive(row)) return true; // active complimentary (coupon) plan
  const planActive =
    row.plan !== "free" &&
    (row.subscription_status === "active" || row.subscription_status === "trialing");
  return planActive || row.credits > 0;
}

// ── Coupon redemption ────────────────────────────────────────────────────────

/** Redeem a coupon code for a complimentary Pro plan. Each code can be redeemed
 *  once per account; redeeming while already comped extends from the current end
 *  date (codes stack). Throws (code INVALID) on an unknown or already-used code. */
export async function redeemCoupon(email: string, rawCode: string): Promise<RedeemResult> {
  const code = normalizeCode(rawCode);
  if (!code) throw invalid("Enter a coupon code.");
  if (!couponCodes().has(code)) throw invalid("That coupon code isn't valid.");

  const db = await getDb();
  // Claim the (code, email) pair; a duplicate means the user already used it.
  const res = db
    .prepare("INSERT OR IGNORE INTO coupon_redemptions (code, email, redeemed_at) VALUES (?, ?, ?)")
    .run(code, email, new Date().toISOString()) as { changes?: number };
  if (res && typeof res.changes === "number" && res.changes === 0) {
    throw invalid("You've already redeemed this code.");
  }

  const months = couponMonths();
  const row = await readRow(email);
  // Stack onto an active comp, otherwise start from now.
  const base = compActive(row) ? new Date(row!.current_period_end as string) : new Date();
  base.setMonth(base.getMonth() + months);
  const end = base.toISOString();

  await upsert(email, {
    plan: "pro",
    subscription_status: COMPED,
    subscription_id: null,
    current_period_end: end,
    cancel_at_period_end: 1, // complimentary — never auto-renews
  });

  return {
    plan: "pro",
    months,
    currentPeriodEnd: end,
    message: `${months} months of Pro unlocked — enjoy!`,
  };
}

// ── Stripe customer ─────────────────────────────────────────────────────────

async function getOrCreateCustomer(email: string): Promise<string> {
  const existing = await readRow(email);
  const s = requireStripe();
  // Reuse the stored customer only if it still exists in the *current* Stripe
  // account. A stored id created under a different key (e.g. after a live→test
  // switch) triggers "No such customer" at checkout — verify and recreate.
  if (existing?.customer_id) {
    try {
      const c = await s.customers.retrieve(existing.customer_id);
      if (!(c as Stripe.DeletedCustomer).deleted) return existing.customer_id;
    } catch {
      // unknown/foreign customer — fall through and create a fresh one
    }
  }
  const customer = await s.customers.create({ email, metadata: { labee_email: email } });
  await upsert(email, { customer_id: customer.id });
  return customer.id;
}

// ── Checkout + portal ───────────────────────────────────────────────────────

/** Start a hosted Stripe Checkout session for a catalog product. Returns the
 *  URL the browser should be sent to. `origin` is the app's absolute base URL. */
export async function createCheckout(
  email: string,
  productId: string,
  origin: string,
  amountCents?: number,
): Promise<string> {
  const s = requireStripe();
  const customer = await getOrCreateCustomer(email);
  const base = origin.replace(/\/+$/, "");

  // Custom credit top-up: the buyer names the amount, so there's no fixed price.
  // Charge an ad-hoc price_data line item (mode=payment); the webhook grants
  // credits equal to the amount actually paid.
  if (productId === CUSTOM_CREDITS_PRODUCT_ID) {
    const cents = Math.round(amountCents ?? 0);
    if (!Number.isFinite(cents) || cents < MIN_TOPUP_CENTS) {
      throw invalid(`Minimum top-up is $${(MIN_TOPUP_CENTS / 100).toFixed(0)}.`);
    }
    const session = await s.checkout.sessions.create({
      customer,
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: CURRENCY,
            unit_amount: cents,
            product_data: { name: "Labee credits" },
          },
        },
      ],
      success_url: `${base}/settings?checkout=success`,
      cancel_url: `${base}/settings?checkout=cancel`,
      metadata: { labee_email: email, product_id: productId, kind: "credits" },
      payment_intent_data: { metadata: { labee_email: email } },
    });
    if (!session.url) throw invalid("Stripe did not return a checkout URL.");
    return session.url;
  }

  // productId is the Stripe price id (the dynamic catalog uses price ids as ids).
  const ref = configuredPrices().find((r) => r.priceId === productId);
  if (!ref) throw invalid("Unknown or unavailable product.");

  // Honor a free trial on subscription checkouts (price trial or global default).
  const trialDays =
    ref.kind === "subscription" ? trialDaysFor(await fetchPrice(ref.priceId)) : 0;

  const session = await s.checkout.sessions.create({
    customer,
    mode: ref.kind === "subscription" ? "subscription" : "payment",
    line_items: [{ price: ref.priceId, quantity: 1 }],
    success_url: `${base}/settings?checkout=success`,
    cancel_url: `${base}/settings?checkout=cancel`,
    metadata: { labee_email: email, product_id: ref.priceId, kind: ref.kind },
    ...(ref.kind === "credits"
      ? { payment_intent_data: { metadata: { labee_email: email } } }
      : {
          subscription_data: {
            metadata: { labee_email: email },
            ...(trialDays > 0 ? { trial_period_days: trialDays } : {}),
          },
        }),
  });
  if (!session.url) throw invalid("Stripe did not return a checkout URL.");
  return session.url;
}

/** Open the Stripe customer billing portal (manage/cancel subscription, view
 *  invoices). Requires an existing customer record. */
export async function createPortalSession(email: string, origin: string): Promise<string> {
  const s = requireStripe();
  const row = await readRow(email);
  if (!row?.customer_id) throw invalid("No billing account yet — make a purchase first.");
  // Recreate the customer if the stored id is foreign to the current account
  // (avoids "No such customer" after a key/account switch).
  const customer = await getOrCreateCustomer(email);
  const base = origin.replace(/\/+$/, "");
  const portal = await s.billingPortal.sessions.create({
    customer,
    return_url: `${base}/settings`,
  });
  return portal.url;
}

// ── Webhook ─────────────────────────────────────────────────────────────────

/** Resolve the Labee email for a Stripe customer id, falling back to metadata. */
async function emailForCustomer(
  customerId: string | null,
  metaEmail: string | undefined,
): Promise<string | null> {
  if (metaEmail) return metaEmail;
  if (!customerId) return null;
  const db = await getDb();
  const row = db.prepare("SELECT email FROM billing WHERE customer_id = ?").get(customerId) as
    | { email: string }
    | undefined;
  return row?.email ?? null;
}

function isoFromUnix(seconds: number | null | undefined): string | null {
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}

/** Reconcile the local row from a Stripe Subscription object, and grant the
 *  plan's credit allowance once per billing period. */
async function applySubscription(email: string, sub: Stripe.Subscription): Promise<void> {
  const priceId = sub.items.data[0]?.price?.id ?? null;
  const status = sub.status;
  const active = status === "active" || status === "trialing";
  const plan = active ? (planForPriceId(priceId) ?? "free") : "free";
  const periodEnd = isoFromUnix(sub.items.data[0]?.current_period_end);
  await upsert(email, {
    plan,
    subscription_id: sub.id,
    subscription_status: status,
    subscription_price_id: active ? priceId : null,
    current_period_end: periodEnd,
    cancel_at_period_end: sub.cancel_at_period_end ? 1 : 0,
    customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
  });

  // Credit the plan's usage allowance (Pro/Max) once per period. A new period
  // (renewal) has a different current_period_end, so the guard both grants the
  // first period and tops up on each renewal, while ignoring duplicate webhooks.
  if (active && (plan === "pro" || plan === "max") && periodEnd) {
    const row = await readRow(email);
    if (row?.credited_period !== periodEnd) {
      await addCredits(email, planCreditCents(plan), "subscription");
      await upsert(email, { credited_period: periodEnd });
    }
  }
}

/** Verify + handle a Stripe webhook. Throws (code INVALID) on a bad signature. */
export async function handleWebhook(rawBody: string, signature: string | undefined): Promise<void> {
  const s = requireStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw invalid("STRIPE_WEBHOOK_SECRET is not configured.");
  if (!signature) throw invalid("Missing stripe-signature header.");

  let event: Stripe.Event;
  try {
    event = await s.webhooks.constructEventAsync(rawBody, signature, secret);
  } catch (e) {
    throw invalid(`Webhook signature verification failed: ${e instanceof Error ? e.message : e}`);
  }

  // Idempotency: skip events we've already processed.
  const db = await getDb();
  const res = db
    .prepare("INSERT OR IGNORE INTO billing_events (id, type, created_at) VALUES (?, ?, ?)")
    .run(event.id, event.type, new Date().toISOString()) as { changes?: number };
  if (res && typeof res.changes === "number" && res.changes === 0) return;

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const customerId = typeof session.customer === "string" ? session.customer : null;
      const email = await emailForCustomer(customerId, session.metadata?.labee_email);
      if (!email) break;
      if (customerId) await upsert(email, { customer_id: customerId });
      if (session.mode === "payment" && session.payment_status === "paid") {
        // One-time credit top-up: grant the amount actually paid (cents).
        await addCredits(email, session.amount_total ?? 0);
      } else if (session.mode === "subscription" && session.subscription) {
        const subId =
          typeof session.subscription === "string" ? session.subscription : session.subscription.id;
        const sub = await s.subscriptions.retrieve(subId);
        await applySubscription(email, sub);
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      const email = await emailForCustomer(customerId, sub.metadata?.labee_email);
      if (!email) break;
      if (event.type === "customer.subscription.deleted") {
        await upsert(email, {
          plan: "free",
          subscription_status: "canceled",
          subscription_price_id: null,
          cancel_at_period_end: 0,
        });
      } else {
        await applySubscription(email, sub);
      }
      break;
    }
    default:
      // Unhandled event types are acknowledged (200) and ignored.
      break;
  }
}
