// A small fixed-window rate limiter, in memory.
//
// In-memory is the right fit here: the box runs a single server process, and
// the alternative (a SQLite write on every request) costs more than the thing
// it protects. The trade is that counters reset on restart, which is
// acceptable — a deploy handing out one extra window is not an abuse vector.
//
// Windows are fixed rather than sliding, so a caller can burst up to 2x the
// limit across a window boundary. That's fine for quota protection, and it
// keeps the accounting to one integer per key.

export interface RateLimitResult {
  allowed: boolean;
  /** Requests permitted per window. */
  limit: number;
  /** Requests left in the current window (never negative). */
  remaining: number;
  /** Epoch ms when the current window resets. */
  resetAt: number;
  /** Seconds until reset — for the Retry-After header. */
  retryAfterSeconds: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Drop expired buckets so an endless stream of unique keys can't grow the map
 *  without bound. Cheap: runs at most once a minute, on request. */
let lastSweep = 0;
const SWEEP_INTERVAL_MS = 60_000;
function sweep(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Count one request against `key`. Returns whether it's allowed plus the
 * headers' worth of metadata. A non-positive `limit` means unlimited.
 */
export function consume(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();

  if (limit <= 0) {
    return {
      allowed: true,
      limit: Infinity,
      remaining: Infinity,
      resetAt: now,
      retryAfterSeconds: 0,
    };
  }

  sweep(now);

  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }

  bucket.count += 1;
  const allowed = bucket.count <= limit;
  return {
    allowed,
    limit,
    remaining: Math.max(0, limit - bucket.count),
    resetAt: bucket.resetAt,
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

/** Test seam. */
export function resetRateLimits(): void {
  buckets.clear();
  lastSweep = 0;
}

/**
 * The client's IP as seen by our own reverse proxy.
 *
 * nginx is configured with `$proxy_add_x_forwarded_for`, which *appends*
 * `$remote_addr` to whatever the client sent. So the header is
 * `<client-supplied…>, <real peer>` and only the LAST entry is trustworthy —
 * taking the first would let any caller mint an unlimited number of rate-limit
 * keys just by sending their own X-Forwarded-For.
 */
export function clientIp(headers: Record<string, string | undefined>): string {
  const forwarded = headers["x-forwarded-for"] ?? headers["X-Forwarded-For"];
  if (forwarded) {
    const parts = forwarded.split(",").map((p) => p.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  return headers["x-real-ip"] ?? "unknown";
}
