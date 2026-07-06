import { Schema } from "effect";

/** Account plan tiers. `free` is the default for everyone. */
export const PlanTier = Schema.Literals(["free", "pro", "max"]);
export type PlanTier = typeof PlanTier.Type;

/** A purchasable item in the billing catalog. */
export const BillingProduct = Schema.Struct({
  /** Stable key, e.g. "pro", "max", "credits_10". */
  id: Schema.String,
  /** A recurring subscription, or a one-time credit top-up. */
  kind: Schema.Literals(["subscription", "credits"]),
  label: Schema.String,
  description: Schema.String,
  /** Display amount in the smallest currency unit (cents). */
  amount: Schema.Number,
  currency: Schema.String,
  /** Subscriptions only: billing interval (day/week/month/year) + plan granted. */
  interval: Schema.optional(Schema.String),
  plan: Schema.optional(PlanTier),
  /** Subscriptions only: free-trial length in days, when one applies. */
  trialDays: Schema.optional(Schema.Number),
  /** Credits only: true when the buyer chooses the amount at Checkout
   *  (pay-what-you-want price with custom_unit_amount). */
  customAmount: Schema.optional(Schema.Boolean),
});
export type BillingProduct = typeof BillingProduct.Type;

/** Current billing state for the signed-in user + the purchasable catalog
 *  (GET /api/billing). Credits are an account balance in cents. */
export const BillingState = Schema.Struct({
  /** Is Stripe wired up on this server? When false, the UI shows a notice. */
  configured: Schema.Boolean,
  plan: PlanTier,
  /** Stripe subscription status (active/trialing/past_due/…), or null. */
  subscriptionStatus: Schema.NullOr(Schema.String),
  /** The Stripe price id of the active subscription — lets the UI mark the exact
   *  purchased price as current (e.g. Pro monthly vs Pro annual), not the whole
   *  plan tier. Null when there's no active paid subscription. */
  subscriptionPriceId: Schema.NullOr(Schema.String),
  /** ISO timestamp the current period ends (renewal/expiry), or null. */
  currentPeriodEnd: Schema.NullOr(Schema.String),
  /** True when the subscription is set to cancel at period end. */
  cancelAtPeriodEnd: Schema.Boolean,
  /** Credit balance in cents. */
  credits: Schema.Number,
  /** Lifetime amount spent on metered usage, in cents. */
  spent: Schema.Number,
  /** The starting balance every new account is granted, in cents (display). */
  signupGrant: Schema.Number,
  currency: Schema.String,
  /** Can the user open the Stripe billing portal (has a customer record)? */
  canManage: Schema.Boolean,
  catalog: Schema.Array(BillingProduct),
});
export type BillingState = typeof BillingState.Type;

/** A single entry in the account's credit ledger (grant / spend / top-up). */
export const UsageEvent = Schema.Struct({
  id: Schema.Number,
  /** Why the balance changed. */
  kind: Schema.Literals(["grant", "spend", "topup", "subscription", "adjustment"]),
  /** Signed change to the balance in cents (spend is negative). */
  amount: Schema.Number,
  /** Metered calls only: the vendor and model, and token counts. */
  provider: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  createdAt: Schema.String,
});
export type UsageEvent = typeof UsageEvent.Type;

/** GET /api/billing/usage — the account's spend summary + recent ledger. */
export const UsageSummary = Schema.Struct({
  /** Current balance in cents. */
  balance: Schema.Number,
  /** Lifetime credited (signup grant + top-ups), in cents. */
  granted: Schema.Number,
  /** Lifetime spent on metered usage, in cents. */
  spent: Schema.Number,
  currency: Schema.String,
  /** Most-recent ledger entries, newest first. */
  events: Schema.Array(UsageEvent),
});
export type UsageSummary = typeof UsageSummary.Type;

/** Sentinel product id for a custom-amount credit top-up (the buyer types the
 *  dollar amount; there's no fixed Stripe price). */
export const CUSTOM_CREDITS_PRODUCT_ID = "credits_custom";

/** Minimum credit top-up, in cents ($5). */
export const MIN_TOPUP_CENTS = 500;

/** POST /api/billing/checkout — start a hosted Stripe Checkout for a product. */
export const CheckoutRequest = Schema.Struct({
  productId: Schema.String,
  /** For the custom credit top-up: the amount to charge, in cents (≥ 500). */
  amountCents: Schema.optional(Schema.Number),
});
export type CheckoutRequest = typeof CheckoutRequest.Type;

/** A redirect URL the client sends the browser to (Checkout or billing portal). */
export const RedirectUrl = Schema.Struct({ url: Schema.String });
export type RedirectUrl = typeof RedirectUrl.Type;

/** POST /api/billing/redeem — redeem a coupon code for a complimentary plan. */
export const RedeemRequest = Schema.Struct({
  code: Schema.String,
});
export type RedeemRequest = typeof RedeemRequest.Type;

/** Result of redeeming a coupon: the plan granted and when it ends. */
export const RedeemResult = Schema.Struct({
  plan: PlanTier,
  /** How many months of access the code granted. */
  months: Schema.Number,
  /** ISO timestamp the complimentary plan runs through. */
  currentPeriodEnd: Schema.NullOr(Schema.String),
  message: Schema.String,
});
export type RedeemResult = typeof RedeemResult.Type;
