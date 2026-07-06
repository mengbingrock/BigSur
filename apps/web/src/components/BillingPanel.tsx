import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CreditCard, ExternalLink, Loader2, Sparkles, Ticket } from "lucide-react";
import {
  CUSTOM_CREDITS_PRODUCT_ID,
  MIN_TOPUP_CENTS,
  type BillingProduct,
  type BillingState,
  type RedeemResult,
  type RedirectUrl,
  type UsageEvent,
  type UsageSummary,
} from "@labee/contracts";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { apiGet, apiSend } from "~/lib/api";
import { cn } from "~/lib/utils";

const BILLING_KEY = ["billing"] as const;
const USAGE_KEY = ["billing", "usage"] as const;

function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

const PLAN_LABEL: Record<string, string> = { free: "Free", pro: "Pro", max: "Max" };

/** Human label for a subscription status. */
function subLabel(status: string): string {
  if (status === "trialing") return "Free trial";
  if (status === "comped") return "Complimentary";
  return status;
}

/** Billing: current plan + credit balance, hosted-Checkout buttons for
 *  subscriptions and credit top-ups, and a link to the Stripe billing portal.
 *  Reads the `?checkout=success|cancel` return param from Stripe. */
export function BillingPanel({ checkout }: { checkout?: "success" | "cancel" }) {
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);

  const billingQ = useQuery({
    queryKey: BILLING_KEY,
    queryFn: () => apiGet<BillingState>("/api/billing"),
  });
  const usageQ = useQuery({
    queryKey: USAGE_KEY,
    queryFn: () => apiGet<UsageSummary>("/api/billing/usage"),
  });

  // On return from Stripe, surface the outcome and refetch (the webhook may
  // land a beat later, so poll briefly after a success).
  useEffect(() => {
    const refresh = () => {
      void qc.invalidateQueries({ queryKey: BILLING_KEY });
      void qc.invalidateQueries({ queryKey: USAGE_KEY });
    };
    if (checkout === "success") {
      setNotice("Payment received — updating your account…");
      refresh();
      const timers = [1500, 4000, 8000].map((ms) => setTimeout(refresh, ms));
      return () => timers.forEach(clearTimeout);
    }
    if (checkout === "cancel") setNotice("Checkout canceled — no charge was made.");
    return undefined;
  }, [checkout, qc]);

  const redirect = (data: RedirectUrl) => {
    window.location.href = data.url;
  };

  const checkoutM = useMutation({
    mutationFn: (vars: { productId: string; amountCents?: number }) =>
      apiSend<RedirectUrl>("POST", "/api/billing/checkout", vars),
    onSuccess: redirect,
  });
  const portalM = useMutation({
    mutationFn: () => apiSend<RedirectUrl>("POST", "/api/billing/portal", {}),
    onSuccess: redirect,
  });
  const redeemM = useMutation({
    mutationFn: (code: string) =>
      apiSend<RedeemResult>("POST", "/api/billing/redeem", { code }),
    onSuccess: (r) => {
      setNotice(r.message);
      void qc.invalidateQueries({ queryKey: BILLING_KEY });
      void qc.invalidateQueries({ queryKey: USAGE_KEY });
    },
  });

  const billing = billingQ.data;
  const subscriptions = (billing?.catalog ?? []).filter((p) => p.kind === "subscription");
  const busy = checkoutM.isPending || portalM.isPending;
  const pendingId = checkoutM.isPending ? checkoutM.variables?.productId : null;

  return (
    <section id="billing" className="scroll-mt-4 rounded-xl border border-border bg-background">
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex items-center gap-2">
          <CreditCard className="size-4 text-ink-light" />
          <h2 className="font-display text-[0.9375rem] text-ink">Billing & plan</h2>
        </div>
        {billing ? (
          <Badge variant={billing.plan === "free" ? "secondary" : "default"}>
            {PLAN_LABEL[billing.plan] ?? billing.plan}
          </Badge>
        ) : null}
      </header>

      <div className="flex flex-col gap-5 p-5">
        {notice ? (
          <p
            className={cn(
              "rounded-md border px-3 py-2 text-sm",
              checkout === "cancel"
                ? "border-border text-ink-light"
                : "border-brand/40 bg-brand/5 text-ink",
            )}
          >
            {notice}
          </p>
        ) : null}

        {billingQ.isLoading ? (
          <p className="text-sm text-ink-light">Loading…</p>
        ) : billingQ.isError ? (
          <p className="text-sm text-destructive">
            {billingQ.error instanceof Error ? billingQ.error.message : "Failed to load billing."}
          </p>
        ) : !billing?.configured ? (
          <p className="text-sm text-ink-light">
            Payments aren't configured on this server. Set <code>STRIPE_SECRET_KEY</code> (and price
            IDs) to enable subscriptions and credit top-ups.
          </p>
        ) : (
          <>
            {/* Current status */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              <div>
                <span className="text-ink-faint">Credit balance: </span>
                <span className="font-medium text-ink">
                  {money(billing.credits, billing.currency)}
                </span>
                {billing.credits <= 0 ? (
                  <span className="ml-1 text-ink-faint">— top up to keep going</span>
                ) : null}
              </div>
              <div>
                <span className="text-ink-faint">Spent to date: </span>
                <span className="font-medium text-ink">
                  {money(billing.spent ?? 0, billing.currency)}
                </span>
              </div>
              {billing.subscriptionStatus && billing.subscriptionStatus !== "expired" ? (
                <div>
                  <span className="text-ink-faint">Subscription: </span>
                  <span className="text-ink">{subLabel(billing.subscriptionStatus)}</span>
                  {billing.currentPeriodEnd ? (
                    <span className="text-ink-faint">
                      {billing.subscriptionStatus === "trialing" ||
                      billing.subscriptionStatus === "comped" ||
                      billing.cancelAtPeriodEnd
                        ? " · ends "
                        : " · renews "}
                      {new Date(billing.currentPeriodEnd).toLocaleDateString()}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {billing.canManage ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => portalM.mutate()}
                  className="ml-auto"
                >
                  {portalM.isPending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <ExternalLink className="size-3.5" />
                  )}
                  Manage subscription
                </Button>
              ) : null}
            </div>

            {/* Subscription plans */}
            {subscriptions.length > 0 ? (
              <div>
                <h3 className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-ink-light">
                  Plans
                </h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  {subscriptions.map((p) => (
                    <ProductCard
                      key={p.id}
                      product={p}
                      current={billing.subscriptionPriceId === p.id}
                      pending={pendingId === p.id}
                      disabled={busy}
                      onBuy={() => checkoutM.mutate({ productId: p.id })}
                    />
                  ))}
                </div>
              </div>
            ) : null}

            {/* Credit top-up — type any amount ($5 minimum) */}
            <CreditTopUp
              currency={billing.currency}
              disabled={busy}
              pending={pendingId === CUSTOM_CREDITS_PRODUCT_ID}
              onBuy={(amountCents) =>
                checkoutM.mutate({ productId: CUSTOM_CREDITS_PRODUCT_ID, amountCents })
              }
            />

            {/* Redeem a coupon code */}
            <RedeemCoupon
              pending={redeemM.isPending}
              error={
                redeemM.isError
                  ? redeemM.error instanceof Error
                    ? redeemM.error.message
                    : "Could not redeem that code."
                  : null
              }
              onRedeem={(code) => redeemM.mutate(code)}
            />

            {checkoutM.isError ? (
              <p className="text-sm text-destructive">
                {checkoutM.error instanceof Error ? checkoutM.error.message : "Checkout failed."}
              </p>
            ) : null}

            {/* Usage & activity */}
            <UsageActivity usage={usageQ.data} loading={usageQ.isLoading} />
          </>
        )}
      </div>
    </section>
  );
}

/** Credit top-up: the buyer types any dollar amount ($5 minimum) and is sent to
 *  Stripe Checkout for that exact amount. */
function CreditTopUp({
  currency,
  disabled,
  pending,
  onBuy,
}: {
  currency: string;
  disabled: boolean;
  pending: boolean;
  onBuy: (amountCents: number) => void;
}) {
  const min = MIN_TOPUP_CENTS / 100;
  const [amount, setAmount] = useState("20");
  const dollars = Number.parseFloat(amount);
  const valid = Number.isFinite(dollars) && dollars >= min;

  const submit = () => {
    if (!valid || disabled) return;
    onBuy(Math.round(dollars * 100));
  };

  return (
    <div>
      <h3 className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-ink-light">
        Credit top-up
      </h3>
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-background/60 p-4 sm:flex-row sm:items-end">
        <label className="flex-1">
          <span className="mb-1 block text-xs text-ink-light">
            Amount ({currency.toUpperCase()}) — ${min} minimum
          </span>
          <div className="flex items-center gap-2">
            <span className="text-ink-faint">$</span>
            <Input
              type="number"
              inputMode="decimal"
              min={min}
              step="1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              className="max-w-[8rem]"
              aria-label="Top-up amount in dollars"
            />
          </div>
        </label>
        <Button
          size="sm"
          disabled={disabled || !valid}
          onClick={submit}
          className="sm:mb-0.5"
        >
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : <CreditCard className="size-3.5" />}
          Add credits
        </Button>
      </div>
      {amount !== "" && !valid ? (
        <p className="mt-1 text-xs text-destructive">Enter ${min} or more.</p>
      ) : null}
    </div>
  );
}

/** Redeem a coupon code (e.g. a 3-month Pro grant). Non-blocking; the success
 *  message surfaces in the panel notice above. */
function RedeemCoupon({
  pending,
  error,
  onRedeem,
}: {
  pending: boolean;
  error: string | null;
  onRedeem: (code: string) => void;
}) {
  const [code, setCode] = useState("");
  const trimmed = code.trim();
  const submit = () => {
    if (trimmed && !pending) onRedeem(trimmed);
  };
  return (
    <div>
      <h3 className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-ink-light">
        Have a coupon?
      </h3>
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-background/60 p-4 sm:flex-row sm:items-end">
        <label className="flex-1">
          <span className="mb-1 block text-xs text-ink-light">Coupon code</span>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="e.g. LABEE3PRO"
            autoCapitalize="characters"
            spellCheck={false}
            className="font-mono uppercase placeholder:normal-case placeholder:font-sans sm:max-w-[16rem]"
            aria-label="Coupon code"
          />
        </label>
        <Button size="sm" variant="outline" disabled={!trimmed || pending} onClick={submit} className="sm:mb-0.5">
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Ticket className="size-3.5" />}
          Redeem
        </Button>
      </div>
      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/** Recent credit-ledger entries: the $20 signup grant, metered spend per model,
 *  and Stripe top-ups. */
function UsageActivity({ usage, loading }: { usage?: UsageSummary; loading: boolean }) {
  if (loading && !usage) return null;
  const events = usage?.events ?? [];
  return (
    <div>
      <h3 className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-ink-light">
        Usage & activity
      </h3>
      {events.length === 0 ? (
        <p className="text-sm text-ink-light">No activity yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {events.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <div className="min-w-0">
                <span className="text-ink">{eventLabel(e)}</span>
                {e.kind === "spend" && e.inputTokens + e.outputTokens > 0 ? (
                  <span className="ml-2 text-xs text-ink-faint">
                    {e.inputTokens.toLocaleString()} in · {e.outputTokens.toLocaleString()} out
                  </span>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="text-xs text-ink-faint">{when(e.createdAt)}</span>
                <span
                  className={cn(
                    "w-16 text-right font-medium tabular-nums",
                    e.amount < 0 ? "text-ink" : "text-emerald-600 dark:text-emerald-400",
                  )}
                >
                  {e.amount < 0 ? "−" : "+"}
                  {money(Math.abs(e.amount), usage?.currency ?? "usd")}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function eventLabel(e: UsageEvent): string {
  switch (e.kind) {
    case "grant":
      return "Welcome credit";
    case "topup":
      return "Credit top-up";
    case "subscription":
      return "Subscription";
    case "spend":
      return e.model ? modelLabel(e.model) : "Model usage";
    default:
      return "Adjustment";
  }
}

/** Trim a raw model id to something friendly, e.g. "claude-opus-4-8" → "Opus". */
function modelLabel(model: string): string {
  const m = model.toLowerCase();
  if (m.includes("opus")) return "Claude Opus";
  if (m.includes("sonnet")) return "Claude Sonnet";
  if (m.includes("haiku")) return "Claude Haiku";
  if (m.includes("gpt-4o-mini")) return "GPT-4o mini";
  if (m.includes("gpt-4o")) return "GPT-4o";
  if (m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4")) return model.toUpperCase();
  return model;
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function ProductCard({
  product,
  current,
  pending,
  disabled,
  onBuy,
}: {
  product: BillingProduct;
  current?: boolean;
  pending: boolean;
  disabled: boolean;
  onBuy: () => void;
}) {
  const trialDays = product.trialDays ?? 0;
  const buyLabel = current
    ? "Current plan"
    : product.kind === "subscription"
      ? trialDays > 0
        ? "Start free trial"
        : "Subscribe"
      : product.customAmount
        ? "Choose amount"
        : "Buy";
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-background/60 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-ink">{product.label}</span>
        <span className="text-sm text-ink">
          {product.customAmount ? (
            <span className="text-ink-faint">Custom</span>
          ) : (
            <>
              {money(product.amount, product.currency)}
              {product.interval ? (
                <span className="text-ink-faint">/{product.interval}</span>
              ) : null}
            </>
          )}
        </span>
      </div>
      {trialDays > 0 ? (
        <Badge variant="secondary" className="w-fit">
          {trialDays}-day free trial
        </Badge>
      ) : null}
      <p className="flex-1 text-xs text-ink-light">
        {product.description ||
          (product.customAmount ? "Top up your balance by any amount." : "")}
      </p>
      <Button
        size="sm"
        variant={current ? "outline" : "default"}
        disabled={disabled || current}
        onClick={onBuy}
      >
        {pending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : current ? (
          <Check className="size-3.5" />
        ) : product.kind === "subscription" ? (
          <Sparkles className="size-3.5" />
        ) : (
          <CreditCard className="size-3.5" />
        )}
        {buyLabel}
      </Button>
    </div>
  );
}
