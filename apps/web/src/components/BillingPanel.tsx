import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CreditCard, ExternalLink, Loader2, Sparkles } from "lucide-react";
import type { BillingProduct, BillingState, RedirectUrl } from "@labee/contracts";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { apiGet, apiSend } from "~/lib/api";
import { cn } from "~/lib/utils";

const BILLING_KEY = ["billing"] as const;

function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

const PLAN_LABEL: Record<string, string> = { free: "Free", pro: "Pro", max: "Max" };

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

  // On return from Stripe, surface the outcome and refetch (the webhook may
  // land a beat later, so poll briefly after a success).
  useEffect(() => {
    if (checkout === "success") {
      setNotice("Payment received — updating your account…");
      void qc.invalidateQueries({ queryKey: BILLING_KEY });
      const timers = [1500, 4000, 8000].map((ms) =>
        setTimeout(() => void qc.invalidateQueries({ queryKey: BILLING_KEY }), ms),
      );
      return () => timers.forEach(clearTimeout);
    }
    if (checkout === "cancel") setNotice("Checkout canceled — no charge was made.");
    return undefined;
  }, [checkout, qc]);

  const redirect = (data: RedirectUrl) => {
    window.location.href = data.url;
  };

  const checkoutM = useMutation({
    mutationFn: (productId: string) =>
      apiSend<RedirectUrl>("POST", "/api/billing/checkout", { productId }),
    onSuccess: redirect,
  });
  const portalM = useMutation({
    mutationFn: () => apiSend<RedirectUrl>("POST", "/api/billing/portal", {}),
    onSuccess: redirect,
  });

  const billing = billingQ.data;
  const subscriptions = (billing?.catalog ?? []).filter((p) => p.kind === "subscription");
  const credits = (billing?.catalog ?? []).filter((p) => p.kind === "credits");
  const busy = checkoutM.isPending || portalM.isPending;
  const pendingId = checkoutM.isPending ? checkoutM.variables : null;

  return (
    <section className="rounded-xl border border-border bg-background">
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
              </div>
              {billing.subscriptionStatus ? (
                <div>
                  <span className="text-ink-faint">Subscription: </span>
                  <span className="text-ink">{billing.subscriptionStatus}</span>
                  {billing.currentPeriodEnd ? (
                    <span className="text-ink-faint">
                      {billing.cancelAtPeriodEnd ? " · ends " : " · renews "}
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
                      current={billing.plan === p.plan}
                      pending={pendingId === p.id}
                      disabled={busy}
                      onBuy={() => checkoutM.mutate(p.id)}
                    />
                  ))}
                </div>
              </div>
            ) : null}

            {/* Credit packs */}
            {credits.length > 0 ? (
              <div>
                <h3 className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-ink-light">
                  Credit top-ups
                </h3>
                <div className="grid gap-3 sm:grid-cols-3">
                  {credits.map((p) => (
                    <ProductCard
                      key={p.id}
                      product={p}
                      pending={pendingId === p.id}
                      disabled={busy}
                      onBuy={() => checkoutM.mutate(p.id)}
                    />
                  ))}
                </div>
              </div>
            ) : null}

            {checkoutM.isError ? (
              <p className="text-sm text-destructive">
                {checkoutM.error instanceof Error ? checkoutM.error.message : "Checkout failed."}
              </p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
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
  const buyLabel = current
    ? "Current plan"
    : product.kind === "subscription"
      ? "Subscribe"
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
