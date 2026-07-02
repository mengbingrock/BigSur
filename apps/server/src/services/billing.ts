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
import type { BillingProduct, BillingState, PlanTier } from "@labee/contracts";
import { getDb } from "./db";
import { findUser } from "./users";

const CURRENCY = "usd";

interface BillingRow {
  email: string;
  customer_id: string | null;
  plan: string;
  subscription_id: string | null;
  subscription_status: string | null;
  current_period_end: string | null;
  cancel_at_period_end: number;
  credits: number;
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
    updated_at: new Date().toISOString(),
  };
  db.prepare(
    "INSERT INTO billing (email, customer_id, plan, subscription_id, subscription_status, " +
      "current_period_end, cancel_at_period_end, credits, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(email) DO UPDATE SET " +
      "customer_id = excluded.customer_id, plan = excluded.plan, " +
      "subscription_id = excluded.subscription_id, subscription_status = excluded.subscription_status, " +
      "current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end, " +
      "credits = excluded.credits, updated_at = excluded.updated_at",
  ).run(
    email,
    next.customer_id,
    next.plan,
    next.subscription_id,
    next.subscription_status,
    next.current_period_end,
    next.cancel_at_period_end,
    next.credits,
    next.updated_at,
  );
}

function coercePlan(v: string | undefined | null): PlanTier {
  return v === "pro" || v === "max" ? v : "free";
}

// ── Public read API ─────────────────────────────────────────────────────────

/** The user's billing state + the purchasable catalog (GET /api/billing). */
export async function getBillingState(email: string): Promise<BillingState> {
  const row = await readRow(email);
  const products = await buildCatalog();
  return {
    configured: billingConfigured(),
    plan: coercePlan(row?.plan),
    subscriptionStatus: row?.subscription_status ?? null,
    currentPeriodEnd: row?.current_period_end ?? null,
    cancelAtPeriodEnd: Boolean(row?.cancel_at_period_end),
    credits: row?.credits ?? 0,
    currency: CURRENCY,
    canManage: Boolean(row?.customer_id),
    catalog: products,
  };
}

/** Credit balance in cents. */
export async function getCredits(email: string): Promise<number> {
  return (await readRow(email))?.credits ?? 0;
}

/** Add credits (cents) to the user's balance. */
export async function addCredits(email: string, cents: number): Promise<void> {
  if (cents <= 0) return;
  const current = await getCredits(email);
  await upsert(email, { credits: current + Math.round(cents) });
}

/** Debit credits if the balance covers it; returns false when it doesn't. */
export async function consumeCredits(email: string, cents: number): Promise<boolean> {
  if (cents <= 0) return true;
  const current = await getCredits(email);
  if (current < cents) return false;
  await upsert(email, { credits: current - Math.round(cents) });
  return true;
}

/** True when the user has an active paid plan or a positive credit balance.
 *  Admins (the account owner / team) are always entitled — they run on Labee's
 *  own account without needing to purchase a plan. */
export async function hasPaidEntitlement(email: string): Promise<boolean> {
  const user = await findUser(email);
  if (user?.isAdmin) return true;
  const row = await readRow(email);
  if (!row) return false;
  const planActive =
    row.plan !== "free" &&
    (row.subscription_status === "active" || row.subscription_status === "trialing");
  return planActive || row.credits > 0;
}

// ── Stripe customer ─────────────────────────────────────────────────────────

async function getOrCreateCustomer(email: string): Promise<string> {
  const existing = await readRow(email);
  if (existing?.customer_id) return existing.customer_id;
  const s = requireStripe();
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
): Promise<string> {
  const s = requireStripe();
  // productId is the Stripe price id (the dynamic catalog uses price ids as ids).
  const ref = configuredPrices().find((r) => r.priceId === productId);
  if (!ref) throw invalid("Unknown or unavailable product.");
  const customer = await getOrCreateCustomer(email);
  const base = origin.replace(/\/+$/, "");

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
  const base = origin.replace(/\/+$/, "");
  const portal = await s.billingPortal.sessions.create({
    customer: row.customer_id,
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

/** Reconcile the local row from a Stripe Subscription object. */
async function applySubscription(email: string, sub: Stripe.Subscription): Promise<void> {
  const priceId = sub.items.data[0]?.price?.id ?? null;
  const status = sub.status;
  const active = status === "active" || status === "trialing";
  const plan = active ? (planForPriceId(priceId) ?? "free") : "free";
  await upsert(email, {
    plan,
    subscription_id: sub.id,
    subscription_status: status,
    current_period_end: isoFromUnix(sub.items.data[0]?.current_period_end),
    cancel_at_period_end: sub.cancel_at_period_end ? 1 : 0,
    customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
  });
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
