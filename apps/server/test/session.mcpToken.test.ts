import { describe, it, expect, beforeAll } from "vitest";

// Sealing needs a password before the module reads it.
beforeAll(() => {
  process.env.SESSION_PASSWORD ??= "test-password-at-least-32-chars-long!!";
});

const load = () => import("../src/services/session");

describe("scoped MCP tokens", () => {
  it("round-trips an email", async () => {
    const { sealMcpToken, readMcpToken } = await load();
    const token = await sealMcpToken("alice@example.com");
    expect(await readMcpToken(token)).toBe("alice@example.com");
  });

  it("rejects a token minted for the llm-proxy scope", async () => {
    const { sealProxyToken, readMcpToken } = await load();
    // Both are sealed with the same password, so only the scope tag stops an
    // inference-proxy token from being replayed against the MCP proxy.
    const proxyToken = await sealProxyToken("alice@example.com");
    expect(await readMcpToken(proxyToken)).toBeNull();
  });

  it("is not accepted by the llm-proxy verifier either", async () => {
    const { sealMcpToken, readProxyToken } = await load();
    const mcpToken = await sealMcpToken("alice@example.com");
    expect(await readProxyToken(mcpToken)).toBeNull();
  });

  it("rejects garbage and undefined", async () => {
    const { readMcpToken } = await load();
    expect(await readMcpToken(undefined)).toBeNull();
    expect(await readMcpToken("not-a-sealed-token")).toBeNull();
  });

  it("outlives a long agent turn", async () => {
    const { MCP_TOKEN_TTL } = await load();
    // The claude CLI reads the auth header once per spawned process, so the
    // token must survive a whole turn. An hour would be cutting it close.
    expect(MCP_TOKEN_TTL).toBeGreaterThanOrEqual(60 * 60 * 4);
  });
});
