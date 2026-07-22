import { describe, it, expect, beforeEach } from "vitest";
import { clientIp, consume, resetRateLimits } from "../src/services/rateLimit";

beforeEach(() => resetRateLimits());

describe("fixed-window rate limiter", () => {
  it("allows up to the limit, then blocks", () => {
    for (let i = 1; i <= 3; i++) {
      expect(consume("k", 3, 60_000).allowed).toBe(true);
    }
    const blocked = consume("k", 3, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("counts each key separately", () => {
    expect(consume("a", 1, 60_000).allowed).toBe(true);
    expect(consume("a", 1, 60_000).allowed).toBe(false);
    expect(consume("b", 1, 60_000).allowed).toBe(true);
  });

  it("treats a non-positive limit as unmetered", () => {
    for (let i = 0; i < 50; i++) {
      expect(consume("paid", 0, 60_000).allowed).toBe(true);
    }
    expect(consume("paid", 0, 60_000).remaining).toBe(Infinity);
  });

  it("reports remaining accurately", () => {
    expect(consume("r", 5, 60_000).remaining).toBe(4);
    expect(consume("r", 5, 60_000).remaining).toBe(3);
  });

  it("starts a fresh window once the old one expires", () => {
    expect(consume("w", 1, 1).allowed).toBe(true);
    expect(consume("w", 1, 1).allowed).toBe(false);
    // Windows are keyed on wall-clock; a 1ms window is already past.
    return new Promise<void>((done) =>
      setTimeout(() => {
        expect(consume("w", 1, 1).allowed).toBe(true);
        done();
      }, 5),
    );
  });
});

describe("clientIp", () => {
  it("takes the LAST X-Forwarded-For entry, which nginx appended", () => {
    // nginx uses $proxy_add_x_forwarded_for, so a client-supplied value is
    // preserved and the real peer is appended. Trusting the first entry would
    // let a caller mint unlimited rate-limit keys.
    expect(clientIp({ "x-forwarded-for": "1.2.3.4" })).toBe("1.2.3.4");
    expect(clientIp({ "x-forwarded-for": "9.9.9.9, 203.0.113.7" })).toBe("203.0.113.7");
  });

  it("ignores a spoofed chain and still lands on the real peer", () => {
    const spoofed = "evil-1, evil-2, evil-3, 203.0.113.7";
    expect(clientIp({ "x-forwarded-for": spoofed })).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip, then a constant", () => {
    expect(clientIp({ "x-real-ip": "198.51.100.2" })).toBe("198.51.100.2");
    expect(clientIp({})).toBe("unknown");
  });
});
