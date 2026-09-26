import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = mkdtempSync(join(tmpdir(), "labee-oauth-test-"));

beforeAll(() => {
  process.env.LABEE_DB_PATH = join(root, "labee.sqlite");
  process.env.LABEE_PUBLIC_URL = "https://labee.example";
  process.env.SESSION_PASSWORD = "test-password-at-least-32-chars-long!!";
  process.env.LABEE_SIGNUP_CREDITS = "3";
  process.env.LABEE_PROTOCOL_SEARCH_CENTS = "1";
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("MCP OAuth and signup search credit", () => {
  it("runs DCR + PKCE, validates access tokens, and rotates refresh tokens", async () => {
    const oauth = await import("../src/services/oauth");
    const { createUser } = await import("../src/services/users");
    await createUser("new@example.com", "long-enough-password", { autoPromoteFirst: false });
    const verifier = "codex-oauth-verifier-that-is-at-least-forty-three-characters";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const client = await oauth.registerOAuthClient({
      client_name: "Codex",
      redirect_uris: ["http://127.0.0.1:43123/callback"],
      token_endpoint_auth_method: "none",
    });
    const params = new URLSearchParams({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: client.redirectUris[0]!,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: oauth.mcpResource(),
      scope: "protocols:search openid email",
      state: "test-state",
    });
    const request = await oauth.validateAuthorizationRequest(params);
    const code = await oauth.issueAuthorizationCode("new@example.com", request);
    const first = await oauth.exchangeAuthorizationCode({
      code,
      clientId: client.clientId,
      redirectUri: client.redirectUris[0]!,
      codeVerifier: verifier,
      resource: oauth.mcpResource(),
    });
    const principal = await oauth.oauthPrincipal(first.access_token);
    expect(principal?.email).toBe("new@example.com");
    expect(principal?.scopes).toContain("protocols:search");

    await expect(oauth.exchangeAuthorizationCode({
      code,
      clientId: client.clientId,
      redirectUri: client.redirectUris[0]!,
      codeVerifier: verifier,
      resource: oauth.mcpResource(),
    })).rejects.toThrow("invalid_grant");

    const refreshed = await oauth.exchangeRefreshToken({
      refreshToken: first.refresh_token,
      clientId: client.clientId,
      resource: oauth.mcpResource(),
    });
    expect(refreshed.refresh_token).not.toBe(first.refresh_token);
    await expect(oauth.exchangeRefreshToken({
      refreshToken: first.refresh_token,
      clientId: client.clientId,
      resource: oauth.mcpResource(),
    })).rejects.toThrow("invalid_grant");
    await oauth.revokeRefreshToken(refreshed.refresh_token);
    await expect(oauth.exchangeRefreshToken({
      refreshToken: refreshed.refresh_token,
      clientId: client.clientId,
      resource: oauth.mcpResource(),
    })).rejects.toThrow("invalid_grant");
  });

  it("grants new accounts credit once and meters searches atomically", async () => {
    const { createUser } = await import("../src/services/users");
    const { getCredits, grantSignupCredits, reserveProtocolSearch } = await import("../src/services/billing");
    await createUser("credit@example.com", "long-enough-password", { autoPromoteFirst: false });
    expect(await grantSignupCredits("credit@example.com")).toBe(3);
    expect(await grantSignupCredits("credit@example.com")).toBe(0);
    expect((await reserveProtocolSearch("credit@example.com", 2)).allowed).toBe(true);
    expect(await getCredits("credit@example.com")).toBe(1);
    expect((await reserveProtocolSearch("credit@example.com", 2)).allowed).toBe(false);
    expect(await getCredits("credit@example.com")).toBe(1);
  });
});
