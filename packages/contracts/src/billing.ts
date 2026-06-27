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
  /** Subscriptions only: billing interval + the plan it grants. */
  interval: Schema.optional(Schema.Literals(["month", "year"])),
  plan: Schema.optional(PlanTier),
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
  /** ISO timestamp the current period ends (renewal/expiry), or null. */
  currentPeriodEnd: Schema.NullOr(Schema.String),
  /** True when the subscription is set to cancel at period end. */
  cancelAtPeriodEnd: Schema.Boolean,
  /** Credit balance in cents. */
  credits: Schema.Number,
  currency: Schema.String,
  /** Can the user open the Stripe billing portal (has a customer record)? */
  canManage: Schema.Boolean,
  catalog: Schema.Array(BillingProduct),
});
export type BillingState = typeof BillingState.Type;

/** POST /api/billing/checkout — start a hosted Stripe Checkout for a product. */
export const CheckoutRequest = Schema.Struct({
  productId: Schema.String,
});
export type CheckoutRequest = typeof CheckoutRequest.Type;

/** A redirect URL the client sends the browser to (Checkout or billing portal). */
export const RedirectUrl = Schema.Struct({ url: Schema.String });
export type RedirectUrl = typeof RedirectUrl.Type;
