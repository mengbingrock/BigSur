// The $5 allowance is only a cap if the meter is honest: sub-cent calls must
// not be free, cached tokens must be counted at their own rate, concurrent
// turns must not overwrite each other's debit, and the ledger must reconcile
// with the balance.
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let dir: string;

async function load() {
  return await import("../src/services/billing");
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "labee-usage-"));
  process.env.LABEE_DATA_DIR = dir;
  process.env.LABEE_DB_PATH = path.join(dir, "labee.sqlite");
  delete process.env.LABEE_SIGNUP_CREDITS;
  delete process.env.LABEE_USAGE_MARGIN;
  vi.resetModules();
});

describe("the signup allowance", () => {
  it("is $5", async () => {
    const b = await load();
    expect(b.signupGrantCents()).toBe(500);
  });

  it("is overridable", async () => {
    process.env.LABEE_SIGNUP_CREDITS = "1500";
    const b = await load();
    expect(b.signupGrantCents()).toBe(1500);
    delete process.env.LABEE_SIGNUP_CREDITS;
  });

  it("is granted once and leaves the account with exactly $5", async () => {
    const b = await load();
    expect(await b.grantSignupCredits("a@example.com")).toBe(500);
    expect(await b.grantSignupCredits("a@example.com")).toBe(0);
    expect(await b.getCredits("a@example.com")).toBe(500);
  });
});

describe("metering", () => {
  it("charges a sub-cent call instead of rounding it away", async () => {
    const b = await load();
    await b.grantSignupCredits("s@example.com");
    // 1000 haiku input tokens = 0.08 cents — under half a cent.
    for (let i = 0; i < 12; i++) {
      await b.recordUsage({
        email: "s@example.com",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        inputTokens: 1000,
        outputTokens: 0,
      });
    }
    // 12 × 0.08c = 0.96c → nothing whole yet, but it is carried, not lost.
    const spent = (await b.getUsageSummary("s@example.com")).spent;
    expect(spent).toBeCloseTo(0.96, 2);
    // The thirteenth crosses a cent and the balance finally moves.
    await b.recordUsage({
      email: "s@example.com",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 1000,
      outputTokens: 0,
    });
    expect(await b.getCredits("s@example.com")).toBe(499);
  });

  it("prices cached tokens below fresh input and cache writes above it", async () => {
    const { priceUsage } = await import("../src/services/pricing");
    const fresh = priceUsage("claude-sonnet-4-5", 1_000_000, 0);
    const read = priceUsage("claude-sonnet-4-5", 0, 0, { read: 1_000_000 });
    const write = priceUsage("claude-sonnet-4-5", 0, 0, { write: 1_000_000 });
    expect(fresh).toBe(300);
    expect(read).toBeCloseTo(30, 6);
    expect(write).toBeCloseTo(375, 6);
  });

  it("counts a call that was served entirely from cache", async () => {
    const b = await load();
    await b.grantSignupCredits("c@example.com");
    const cents = await b.recordUsage({
      email: "c@example.com",
      provider: "anthropic",
      model: "claude-opus-5",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 2_000_000,
    });
    // 2M opus cache-read tokens = 2 × 1500 × 0.1 = 300 cents.
    expect(cents).toBe(300);
    expect(await b.getCredits("c@example.com")).toBe(200);
  });

  it("keeps the ledger reconciled with the balance", async () => {
    const b = await load();
    await b.grantSignupCredits("r@example.com");
    for (let i = 0; i < 40; i++) {
      await b.recordUsage({
        email: "r@example.com",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        inputTokens: 3_333,
        outputTokens: 777,
      });
    }
    const summary = await b.getUsageSummary("r@example.com");
    // Balance moved by exactly the whole cents of what the ledger recorded.
    expect(500 - Math.floor(summary.spent)).toBe(summary.balance);
  });

  it("never drives the balance below zero", async () => {
    const b = await load();
    await b.grantSignupCredits("z@example.com");
    await b.recordUsage({
      email: "z@example.com",
      provider: "anthropic",
      model: "claude-opus-5",
      inputTokens: 10_000_000,
      outputTokens: 10_000_000,
    });
    expect(await b.getCredits("z@example.com")).toBe(0);
  });

  it("ignores a call that reported no tokens", async () => {
    const b = await load();
    await b.grantSignupCredits("n@example.com");
    expect(
      await b.recordUsage({
        email: "n@example.com",
        provider: "anthropic",
        model: "claude-opus-5",
        inputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe(0);
    expect(await b.getCredits("n@example.com")).toBe(500);
  });
});

describe("entitlement", () => {
  it("refuses once the allowance is spent", async () => {
    const b = await load();
    await b.grantSignupCredits("e@example.com");
    expect(await b.hasPaidEntitlement("e@example.com")).toBe(true);
    await b.recordUsage({
      email: "e@example.com",
      provider: "anthropic",
      model: "claude-opus-5",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(await b.getCredits("e@example.com")).toBe(0);
    expect(await b.hasPaidEntitlement("e@example.com")).toBe(false);
  });
});
