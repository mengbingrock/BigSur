import { useQuery } from "@tanstack/react-query";
import type { BillingState, CredentialMode, LlmSettings } from "@labee/contracts";
import { apiGet } from "./api";

export const BILLING_KEY = ["billing"] as const;

/** Current billing state + purchasable catalog (GET /api/billing). */
export function useBilling() {
  return useQuery({
    queryKey: BILLING_KEY,
    queryFn: () => apiGet<BillingState>("/api/billing"),
  });
}

/** The credential mode of the user's *active* provider. "provided" is the only
 *  mode that consumes Labee credits — the other modes run on the user's own key
 *  or subscription and are free, so billing is irrelevant there. */
export function useActiveCredentialMode(): CredentialMode | undefined {
  const q = useQuery({
    queryKey: ["llm", "settings"],
    queryFn: () => apiGet<LlmSettings>("/api/llm/settings"),
  });
  const s = q.data;
  return s?.accounts.find((a) => a.provider === s.provider)?.mode;
}

/** True when the account has paid access (a plan, an active/trialing
 *  subscription, or a positive credit balance). */
export function isPaidPlan(b: BillingState | undefined): boolean {
  if (!b) return false;
  if (b.plan !== "free") return true;
  if (b.credits > 0) return true;
  return b.subscriptionStatus === "active" || b.subscriptionStatus === "trialing";
}
