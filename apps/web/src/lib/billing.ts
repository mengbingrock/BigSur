import { useQuery } from "@tanstack/react-query";
import type { BillingState } from "@labee/contracts";
import { apiGet } from "./api";

export const BILLING_KEY = ["billing"] as const;

/** Current billing state + purchasable catalog (GET /api/billing). */
export function useBilling() {
  return useQuery({
    queryKey: BILLING_KEY,
    queryFn: () => apiGet<BillingState>("/api/billing"),
  });
}

/** True when the account has paid access (a plan, an active/trialing
 *  subscription, or a positive credit balance). */
export function isPaidPlan(b: BillingState | undefined): boolean {
  if (!b) return false;
  if (b.plan !== "free") return true;
  if (b.credits > 0) return true;
  return b.subscriptionStatus === "active" || b.subscriptionStatus === "trialing";
}
