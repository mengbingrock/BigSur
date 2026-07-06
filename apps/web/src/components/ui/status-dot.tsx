import { cn } from "~/lib/utils";

// Radar-style status indicator. A small solid core dot sits inside a fixed
// 8px square; when `pulse` is true an outer ring at the full frame size
// scales + fades via `animate-ping`, which reads as "live" much more
// reliably than `animate-pulse` (which only dims opacity and is nearly
// imperceptible on a tiny dot).
//
// `dotClass` must include the fill color (e.g. "bg-orange-500"). It is
// applied to both the core and the halo so the ping inherits the same hue.
export interface StatusDotProps {
  dotClass: string;
  pulse?: boolean;
  label?: string;
  className?: string;
}

export function StatusDot({
  dotClass,
  pulse = false,
  label,
  className,
}: StatusDotProps) {
  // Non-pulsing states (Error, Pending Approval, Awaiting Input, Plan Ready,
  // Completed) fill the whole 8px frame — the halo isn't drawn for them, so
  // shrinking the core to 6px would visually demote them next to the pulsing
  // orange dot. Pulsing states keep a 6px core + 8px animated halo so the
  // ring has room to radiate.
  return (
    <span
      role={label ? "status" : undefined}
      aria-label={label}
      title={label}
      className={cn(
        "relative inline-flex size-2 shrink-0 items-center justify-center",
        className,
      )}
    >
      {pulse ? (
        <>
          <span
            aria-hidden
            className={cn(
              "absolute inline-flex size-full animate-ping rounded-full opacity-70",
              dotClass,
            )}
          />
          <span
            aria-hidden
            className={cn(
              "relative inline-block size-1.5 rounded-full",
              dotClass,
            )}
          />
        </>
      ) : (
        <span
          aria-hidden
          className={cn(
            "relative inline-block size-full rounded-full",
            dotClass,
          )}
        />
      )}
    </span>
  );
}
