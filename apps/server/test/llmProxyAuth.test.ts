import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Anthropic upstream credential.
 *
 * The subscription fallback exists for local development only. It must stay
 * unreachable unless switched on deliberately — gating it on "no API key is
 * configured" would arm it on exactly the misconfigured production box that
 * most needs it off.
 */
type Auth = { kind: string; value: string } | null;

const KEYS = [
  "LABEE_ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY",
  "LABEE_ANTHROPIC_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "LABEE_DEV_SUBSCRIPTION_PROXY",
] as const;

let saved: Record<string, string | undefined>;

/** Reach the module-private resolver through the route's header builder. */
async function resolveAuth(): Promise<Auth> {
  vi.resetModules();
  const mod = (await import("../src/routes/llmProxy")) as unknown as {
    __testAnthropicAuth?: () => Auth;
  };
  return mod.__testAnthropicAuth ? mod.__testAnthropicAuth() : null;
}

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("anthropic upstream credential", () => {
  it("uses the API key when one is configured", async () => {
    process.env.LABEE_ANTHROPIC_API_KEY = "sk-ant-console";
    expect(await resolveAuth()).toEqual({ kind: "apiKey", value: "sk-ant-console" });
  });

  it("refuses to fall back to a subscription token by default", async () => {
    // A production box with no key and a stray CLI login must serve nobody.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-subscription";
    expect(await resolveAuth()).toBeNull();
  });

  it("allows the subscription token only when development opts in", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-subscription";
    process.env.LABEE_DEV_SUBSCRIPTION_PROXY = "1";
    expect(await resolveAuth()).toEqual({
      kind: "oauth",
      value: "sk-ant-oat-subscription",
    });
  });

  it("still prefers an API key when the dev flag is on", async () => {
    process.env.LABEE_ANTHROPIC_API_KEY = "sk-ant-console";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-subscription";
    process.env.LABEE_DEV_SUBSCRIPTION_PROXY = "1";
    expect(await resolveAuth()).toEqual({ kind: "apiKey", value: "sk-ant-console" });
  });

  it("treats any value other than 1 as off", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-subscription";
    for (const v of ["", "0", "true", "yes"]) {
      process.env.LABEE_DEV_SUBSCRIPTION_PROXY = v;
      expect(await resolveAuth(), v).toBeNull();
    }
  });
});
