# Codex plugin: OAuth login + per-user options

Design for letting a codex user run `codex mcp login protocols`, authenticate
against their Labee account in a browser, and then manage their own search
sources and API keys.

Status: **design only** — nothing here is built. Prerequisites that *are* built:
the remote MCP transport, the `/api/protocols/mcp` proxy, scoped tokens, and
tiered rate limiting.

## 1. What the user does

```sh
codex mcp add protocols \
  --url https://labee.online/api/protocols/mcp \
  --oauth-client-id labee-codex
codex mcp login protocols          # browser opens, user approves, done
```

After that, codex holds an access token it refreshes on its own. The user never
copies a secret, and revoking access in Labee kills it everywhere.

They then manage options either in the Labee web UI, or from inside codex via
MCP tools the server exposes (`get_options` / `set_options`), so they never have
to leave the terminal.

## 2. Why OAuth rather than a pasted token

The sealed tokens we mint today are stateless. That's what makes them cheap, and
also what makes them wrong for this: they can't be individually revoked, and
they can't be refreshed, so a pasted token has to be long-lived to be usable —
which is exactly when you'd want revocation. OAuth gives short access tokens
plus a refresh token, and a server-side record we can invalidate.

It's also the standard MCP auth story, so the same server works with any
compliant client, not just codex.

## 3. Architecture

MCP's auth model makes the MCP server an OAuth 2.0 **resource server**, with
discovery driving everything. The flow codex will run:

```
codex ──POST /api/protocols/mcp (no token)
      ◄── 401 + WWW-Authenticate: Bearer resource_metadata="…"
      ──GET /.well-known/oauth-protected-resource      (RFC 9728)
      ◄── { authorization_servers: ["https://labee.online"] }
      ──GET /.well-known/oauth-authorization-server    (RFC 8414)
      ◄── { authorization_endpoint, token_endpoint, registration_endpoint }
      ──POST /oauth/register                           (RFC 7591, dynamic)
      ──browser → /oauth/authorize?…PKCE…&resource=…   (RFC 8707)
      ◄── code → POST /oauth/token → access + refresh
```

### Endpoints to build

| Endpoint | Purpose |
| --- | --- |
| `GET /.well-known/oauth-protected-resource` | Points at the authorization server |
| `GET /.well-known/oauth-authorization-server` | Advertises the endpoints below |
| `POST /oauth/register` | Dynamic client registration |
| `GET /oauth/authorize` | Consent screen; reuses the existing session cookie for login |
| `POST /oauth/token` | Code→token exchange and refresh |
| `POST /oauth/revoke` | Revocation |

PKCE (S256) is mandatory, and the `resource` parameter must be validated so a
token minted for this resource can't be replayed elsewhere.

The `/authorize` screen is the cheapest part: the user is either already signed
in to labee.online, in which case it's a consent button, or gets redirected
through the existing login page first. No new identity system.

### Token model change

This is the real cost. It needs a persistent store, which today's design
deliberately avoids:

```sql
CREATE TABLE oauth_client  (client_id, client_secret_hash, redirect_uris, created_at);
CREATE TABLE oauth_grant   (code, client_id, email, code_challenge, resource, expires_at);
CREATE TABLE oauth_token   (token_hash, refresh_hash, client_id, email, scope,
                            expires_at, revoked_at);
```

Access-token verification changes from "unseal and check the scope tag" to a
table lookup. That's a hash lookup per request against local SQLite — cheap, and
it buys per-token revocation, which is the point.

Keep `sealMcpToken` alongside it. The desktop app's session-derived path works
today and shouldn't be dragged through OAuth for no benefit; the proxy accepts
either credential.

## 4. Per-user options

Two things to store, with quite different handling.

### Search sources and providers

Which journals/vendors to search, the journal provider order, and the vendor
web-search provider. Plain preferences, no secrets:

```sql
CREATE TABLE protocols_options (email PRIMARY KEY, sources_json, providers_json, updated_at);
```

### The user's own API keys

Brave, Google CSE, NCBI, Semantic Scholar. These are secrets and must be
encrypted at rest, with a key **separate from `SESSION_PASSWORD`** — that one
already protects session cookies, and a single compromise shouldn't yield both.
Store them in a `protocols_keys` table under a dedicated `LABEE_SECRETS_KEY`,
and never return them to the client once written; the UI shows presence and a
last-4, and offers replace/delete.

A user supplying their own keys spends their own third-party quota, so they're
exempt from rate limiting — which is also a neat incentive.

### The hard part: getting options to the MCP server

This is the main implementation cost and worth being clear-eyed about.

The MCP server is a *shared, long-lived process* that reads its configuration
from `process.env` at call time. Per-user options can't live in process env
without cross-contaminating concurrent users.

The fix is to make configuration per-request. The proxy already sits in the
path, so it can forward resolved options as headers:

```
X-Protocols-Sources:   star-protocols,nature-protocols,rebase
X-Protocols-Providers: crossref,europepmc
X-Protocols-Brave-Key: <user's key, decrypted just for this call>
```

and the searcher package threads a `RequestConfig` through `search`/`fetch`
instead of reading `process.env` inside each provider. That's a real refactor of
`src/providers/*` in labee-protocol-searcher — mechanical, but it touches every
provider, and it's the piece that decides the schedule.

Alternative considered and rejected: spawning a per-user MCP process with the
right env. Correct, isolates cleanly, and completely impractical on a 512 MB box.

Note the security property this requires: user keys are decrypted only in the
proxy, for the duration of one call, and travel to the MCP service over
loopback. They must never be logged — the MCP server currently logs request
failures to stderr, so that path needs an explicit scrub.

## 5. Suggested phasing

Each phase is independently shippable and useful on its own.

1. **Options without OAuth.** `protocols_options` + web UI + per-request headers
   + the searcher `RequestConfig` refactor. Delivers user value immediately and
   de-risks the hardest technical piece first, before any OAuth work.
2. **Own API keys.** Encrypted store, rate-limit exemption, log scrubbing.
3. **OAuth server.** Discovery, registration, authorize/token/revoke, the token
   tables. Verify against `codex mcp login` early — that's the acceptance test.
4. **MCP-native option tools.** `get_options` / `set_options` so the terminal
   flow never needs the browser after login.

## 6. Risks and open questions

**Verify codex's flow before building to it.** The design follows the MCP
authorization spec, and codex's `--oauth-client-id` / `--oauth-resource` /
`codex mcp login` surface strongly implies it implements exactly that. But that
inference comes from the CLI's `--help`, not from testing. Phase 3 should start
by pointing `codex mcp login` at a throwaway server and capturing the actual
requests, before any endpoint is written to assumption.

**Anonymous callers have no options.** Everything here is per-account, so the
anonymous tier keeps using server defaults. That's consistent, but it means
"try it, then sign in to configure it" — worth making explicit in the docs.

**Consent screen scope.** Deciding what an approved client is allowed to do.
Simplest defensible answer: one `protocols` scope, all three tools, no
granularity, and revisit only if there's demand.

**Writing an OAuth server is a real security surface.** Redirect-URI validation,
code replay, PKCE downgrade, and refresh-token rotation are each a way to get
this wrong. If a hosted identity provider is ever on the table, delegating the
authorization server and keeping only the resource server is much less code to
get right.
