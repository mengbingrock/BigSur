import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Sparkles, X } from "lucide-react";
import { useActiveCredentialMode, useBilling, isPaidPlan } from "~/lib/billing";
import { Button } from "~/components/ui/button";

/**
 * Soft upsell shown in chat when the user's active provider is on "Labee
 * provided" auth without a paid plan. Non-blocking and dismissible for the
 * session — the full catalog lives in Settings → Billing.
 */
export function ProvidedPlanBanner() {
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(false);

  const mode = useActiveCredentialMode();
  const billingQ = useBilling();
  const b = billingQ.data;

  if (dismissed || mode !== "provided" || !b?.configured || isPaidPlan(b)) return null;

  return (
    <div className="mb-3 flex items-center gap-3 rounded-lg border border-brand/40 bg-brand/5 px-3 py-2 text-xs text-ink">
      <Sparkles className="size-4 shrink-0 text-brand" />
      <span className="min-w-0 flex-1">
        You're using <strong>Labee-provided</strong> models. Choose a plan to keep reliable access.
      </span>
      <Button size="xs" variant="default" onClick={() => void navigate({ to: "/settings" })}>
        View plans
      </Button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
        className="shrink-0 text-ink-faint transition hover:text-ink"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
