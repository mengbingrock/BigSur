# Provided device — design

Make "Labee provided" a real **device**: a machine Labee operates that dials
the box, registers itself, and runs sessions for accounts that have no
computer of their own. It can sit anywhere — a spare PC behind NAT, a cloud VM
— and offers whichever engines are installed on it (claude, codex, others).

Status: design only, nothing here is implemented. Written 2026-09-27.
Builds on [mobile-companion-design.md](./mobile-companion-design.md) §5
(Device Link).

**Read §3.4 first.** The research turned up a licensing constraint that
affects how "provided" may run Claude at all, today as well as in this
design.

---

## 1. The problem

A person signs in on the iOS app and has no Mac linked. No host is selected,
so the app sends root paths (`/api/sessions/…`, no `/api/hosts/:hostId`
prefix — `apps/mobile/src/api/client.ts:45`). labee.online answers them with
its own in-process `SessionRunner` and spawns the agent CLI on the box. The
"provided device" exists only as that implicit fallback.

| # | What is wrong today | Where |
|---|---|---|
| 1 | **Execution is welded to the relay.** Agent CLIs with Bash run on the same small shared instance that holds accounts, billing, the mirror and the LLM proxy. Moving execution means moving the whole server. | `services/sessions/runner.ts`, `turnBuilder.ts` |
| 2 | **Accounts are separated by directory only.** Every account's turn runs as the same OS user with the server's environment, and `fullAccess` defaults to on, which maps to `bypassPermissions`. One account's agent can read another's deck. | `turnBuilder.ts:508`, `:556`, `:650`; `claudeRunner.ts:39` |
| 3 | **Provided is not addressable.** Clients special-case "no host". It has no online/offline state, no engine list, and cannot be moved or drained. | `apps/mobile/app/hosts.tsx:37`, `RunsOnPanel.tsx:53` |
| 4 | **Engines are hard-wired.** `prepareTurn` branches on `claude \| codex \| openai`. Codex always runs on the host's own ChatGPT login, returns only its final text, and never goes through the proxy. | `turnBuilder.ts:659-726`, `codex.ts:229` |
| 5 | **The workaround is one Mac per account.** App Review is served by `~/.labee/review-instance`: a headless desktop-mode server linked as the demo account, running on that Mac's own Claude login. | `~/.labee/review-instance/run.sh` |

Item 5 is the useful one: it shows the Device Link already carries a
headless host. What is missing is a host that belongs to Labee rather than to
one account.

---

## 2. Goals and non-goals

**Goals**

1. The provided device is a host on the Device Link like any Mac: outbound
   connection only, no inbound ports, works behind NAT.
2. It registers itself. Starting the worker with an enrollment key is the
   whole installation.
3. One worker serves many accounts, and they cannot see each other or the
   network the worker sits on.
4. The worker holds no provider keys and no user credentials. All inference
   goes through the box proxy and is metered there.
5. Engines are pluggable and advertised by the worker. Claude and codex first;
   a third engine needs an adapter, not changes across the server.
6. The iOS 1.0 build already submitted keeps working unchanged.
7. The box can end up running no agent processes at all.

**Non-goals**

- Workers run by anyone other than Labee. A worker sees prompts and files in
  plaintext, so the operator has to be trusted.
- Autoscaling. The pool is sized by hand.
- Using a Claude or ChatGPT subscription on a provided device.
- End-to-end encryption between client and worker.

---

## 3. Research

### 3.1 What the code already gives us

| Piece | State | Consequence |
|---|---|---|
| Tunnel (`req` / `res` / `chunk` / `end` / `abort`) | Host-agnostic. The box forwards any path; the host replays it against its loopback server. | Reused as is. |
| Host auth on a tunneled request | The host accepts whatever email the box names if the per-process link secret matches. It does not compare the email with its linked account, and needs no local `users` row — per-account folders and rows are created lazily (`httpKit.ts:44`). | A host can already serve any account. Nothing to change on the replay path. |
| Host registration | Bound to one account: the link token is sealed from a user's session cookie (`routes/link.ts:38`), and the registry is an in-memory map `email → hostId` (`deviceLink/hosts.ts:24`). | This needs a second form. |
| Mirror | Keyed `(email, host_id, id)`; the email comes from the connection, not the frame (`routes/link.ts:127`). The client mirrors only its one linked account (`client.ts:227`). | Frames from a worker must carry the email. |
| Provided inference off-box | Exists for desktops: mint a proxy token, point the CLI at `/api/llm/anthropic` (`llmSettings.ts:209`, `llm.ts:73`). | Right mechanism, wrong scope — see 3.2. |
| Server-owned sessions, queue, replay-then-tail SSE | Done. | The worker runs the same `SessionRunner`. |
| Which paths are relayed | Decided in the web client by a deny-list, `BOX_ONLY` (`apps/web/src/lib/api.ts:20-29`). Everything else under `/api/` is relayed, including `/api/account` and `/api/llm/settings`. | A provided device needs a different split (§8.1). |

### 3.2 What is process-global today and has to become per-account

A desktop serves one person, so a lot of state is held once per process. On a
worker each of these would silently charge, or expose, the wrong account.

| Global today | Where | On a worker |
|---|---|---|
| The box session — one cookie file | `llmSettings.ts:159`, `remoteAgents.ts:31` | Replaced by the worker credential (§6). |
| Proxy token cache — one token, not keyed by email | `llmSettings.ts:146` | Per account, held by the gateway (§10.2). As written, every account's usage would be billed to whoever linked the host. |
| Protocol-search MCP token, written into `process.env` | `protocolsMcp.ts:108-123` | Per account, passed per turn. |
| Billing and transcription forwarding | `routes/billing.ts:25`, `routes/transcribe.ts:58` | Not relayed at all; the box answers them (§8.1). |
| Agent and skills sync, tied to the linked account or one env login | `client.ts:196`, `remoteSkills.ts:19` | Per tenant, driven by the box. |
| `~/.claude` user settings loaded for every account (`--setting-sources project,user`) | `turnBuilder.ts:713` | Per-tenant config directory; project settings only. |
| `~/.codex/config.toml` rewritten before every codex run | `codex.ts:222`, `protocolsMcp.ts:160` | Per-tenant `CODEX_HOME`. Concurrent turns would otherwise overwrite each other. |
| `--chrome` drives the host's browser | `turnBuilder.ts:717` | Off. |
| Granted folders and the folder browser, confined to one shared `$HOME`; agent `workingDir` unconfined | `userFolders.ts:125`, `fs.ts:14`, `agents.ts:74` | Off, and `workingDir` confined to the tenant directory. |
| Research `command` evaluators run through a shell in the server process | `research/evaluator.ts:37` | Must go through the sandbox like any engine. |

### 3.3 Prior art

How CI systems enroll machines they do not control the network of:

| System | Enrollment | Machine identity | Per-job |
|---|---|---|---|
| GitHub Actions | Registration token, valid 1 h | Runner keypair, exchanged for a token | JIT config: one job, then the runner is removed |
| Buildkite | Agent token, cluster-scoped | Session token for the life of the connection | Job token, dies with the job |
| GitLab | Runner created on the server first; tags set there | `glrt-` token in the runner's config | Job token |
| Tailscale | Auth key: one-off or reusable, 1–90 days | Node key; survives the auth key expiring | — |

The pattern is the same everywhere: a short-lived enrollment secret is
exchanged for a per-machine identity that is stored locally and can be
revoked; work is scoped by a narrower token still; capabilities are labels
the server matches on; liveness is a heartbeat with an explicit "lost" state.
None of them re-run lost work by default, because the work has side effects.
§6 and §16 follow this.

Sandboxing, from the vendors' own documentation:

- Claude Code's built-in sandbox restricts "every Bash, PowerShell, or
  Monitor command and its child processes". File tools and MCP servers are
  outside it. By default it can read the whole machine. If it cannot start it
  falls back to running unsandboxed unless `failIfUnavailable` is set. macOS,
  Linux and WSL2 only.
- Codex has `read-only`, `workspace-write` and `danger-full-access`, enforced
  by Seatbelt or bubblewrap. Native Windows support is weaker.
- Anthropic's deployment guidance ranks a container or VM above the built-in
  sandbox for isolation, and quotes roughly 1 GiB of memory per agent
  process.

So the engine's own sandbox cannot be the boundary between accounts. It is a
second layer inside a container (§9).

### 3.4 Provider terms

Verified against <https://code.claude.com/docs/en/legal-and-compliance> on
2026-09-27. Two separate rules:

1. **Subscription credentials.** "Anthropic does not permit third-party
   developers to offer Claude.ai login into their own applications, or to
   route requests through Free, Pro, or Max plan credentials on behalf of
   their users."
   The guard for this in `routes/llmProxy.ts:78` is commented out, and the
   deployment notes say production inference uses
   `LABEE_ANTHROPIC_OAUTH_TOKEN`.

2. **Running the Claude Code binary in a product.** "Unless we've mutually
   agreed otherwise, preinstalling or running Claude Code in your products or
   services (e.g. in hosted sandboxes or other agent infrastructure)"
   requires the Commercial Terms and: "Customers may not pay for, resell, or
   intermediate Claude usage on their end users' behalf. Each end user must
   authenticate with their own Anthropic API key, Claude subscription plan
   credentials, or 3P inference provider credential."

Rule 2 describes "Labee provided" exactly: Labee pays, meters and resells,
and the engine is the `claude` binary. It applies to the box today, not only
to a future worker. The same page points developers building products to
"API key authentication through Claude Console", "including those using the
Agent SDK".

This is a reading of published terms, not legal advice. It needs a decision
before phase 1, and §11 is written so that either outcome fits:

| Route | Effect on the design |
|---|---|
| Written agreement with Anthropic covering provided use of the binary | None. The `claude` adapter is used as is. |
| Build the provided Claude engine on the Agent SDK with a Console API key | A second adapter, `claude-sdk`, for provided devices. Personal hosts keep the CLI, where the person signs in themselves. |
| Neither | Provided devices offer codex and other engines only; Claude needs the person's own Mac or API key. |

For OpenAI the documentation says to use API key authentication for
programmatic Codex use. The terms page itself could not be fetched, so the
equivalent resale question is unverified.

---

## 4. Architecture

```
  iPhone / iPad / browser
        │  HTTPS + SSE
        ▼
  ┌───────────────────────────── labee.online (box) ─────────────────────────────┐
  │  accounts · billing · devices · push · mirror · LLM proxy (keys live here)  │
  │                                                                              │
  │  dispatcher:  /api/hosts/<mac>/…      → that account's Mac                   │
  │               /api/hosts/provided/…   → the account's assigned worker        │
  │               /api/sessions/… (root)  → same as "provided"                   │
  │                                                                              │
  │  worker registry · assignments · enrollment keys                             │
  └───────────────▲───────────────────────────────────────▲─────────────────────┘
                  │ outbound WSS (tunnel + mirror)        │ HTTPS (inference)
  ┌───────────────┴───────────────────────────────────────┴─────────────────────┐
  │  worker — any PC, anywhere                                                   │
  │  supervisor: @labee/server in LABEE_MODE=worker, loopback only               │
  │   ├ LinkClient        worker credential, protocol v2                         │
  │   ├ SessionRunner     unchanged                                              │
  │   ├ engine registry   claude · codex · …                                     │
  │   ├ inference gateway one nonce per turn                                     │
  │   └ sandbox driver    one container per tenant                               │
  │                                                                              │
  │   tenants/<id>/  deck · skills · engine config · sessions                    │
  └──────────────────────────────────────────────────────────────────────────────┘
```

Vocabulary used below:

- **Host** — any machine that runs sessions and dials the box.
- **Personal host** — a Mac linked to one account. Unchanged by this design.
- **Provided device** — what the person sees: one device called "Labee".
- **Worker** — one machine behind the provided device. People never see
  workers, only the provided device.
- **Tenant** — an account's footprint on a worker.

---

## 5. The main decision: where to cut

Two places to split the box from the machine that executes.

| | A. Whole host (tunnel HTTP) | B. Engine only (remote exec) |
|---|---|---|
| What moves to the worker | The full server: sessions, deck, skills, research, engines | Only the CLI process |
| Where state lives | On the worker, mirrored to the box | On the box |
| New protocol | None — Device Link as it is | Job protocol plus two-way workspace sync around every turn |
| Workers are | Stateful, accounts are pinned to one | Stateless, any worker serves any account |
| Feature coverage | Everything a Mac does, for free | Each feature that touches files needs its own sync story |
| Box load | Relay only | Still stores and serves every account's files |

**Recommendation: A.** It is what "treat it as a device" means, it reuses the
Device Link whole, and it takes file storage off the box. Its cost is that
state lives on the worker, which §12 deals with: the mirror covers
transcripts from day one, and snapshots make accounts movable later.

B becomes attractive only if the pool grows to the point where pinning
accounts to machines is an operational burden. Snapshots (§12) get most of
that benefit without a sync protocol.

---

## 6. Enrollment and identity

Three credentials, each narrower and shorter-lived than the one before.

```
enrollment key    lwe_…  admin creates it on the box; single use by default, expires in 24 h
      │  POST /api/link/workers/enroll { key, name, os, arch }
      ▼
worker credential lww_…  returned once, stored 0600 in the worker's data dir;
      │                  the box keeps only its hash (same scheme as link_devices)
      │  POST /api/link/worker-token   Authorization: Bearer lww_…
      ▼
link token               sealed, scope "worker-link", 5 min — used once to open the socket
```

Installation on the third PC is then one command:

```
labee-worker --server https://labee.online --enroll lwe_…
```

On first start it enrolls, stores its credential, and connects. On later
starts it finds the credential and connects. The enrollment key is never
written to disk.

```
link_workers
  id            text pk        "wrk_…"
  name          text           "office-pc"
  token_hash    text
  status        text           "active" | "draining" | "revoked"
  single_tenant integer        1 = never place more than one account here
  labels        text           json, e.g. ["gpu","eu"]
  created_by    text           admin email
  created_at, last_seen_at

link_enroll_keys
  key_hash, created_by, expires_at, used_at, used_by_worker
```

Unlike personal hosts, workers are persisted: the box has to know a worker
exists while it is offline, to keep its assignments.

Revoking a worker closes its socket and rejects its credential. Accounts
assigned to it fall back to the mirror (read-only) until reassigned.

---

## 7. Link protocol v2

Additive. A v1 Mac keeps working against a v2 box.

```
worker → box   hello   { hostId, name, version: "2",
                         kind: "provided",
                         build: "0.4.0",
                         os, arch,
                         sandbox: "container" | "none",
                         engines: [ { id: "claude", version: "…", providers: ["anthropic"] },
                                    { id: "codex",  version: "…", providers: ["openai"] } ],
                         capacity: { maxTurns: 4 } }

box → worker   welcome { workerId, pingMs, minBuild, limits }
               req     { …, user, tenantId,
                         ctx: { provider, model, credentialMode, plan } }
               drain   { }                       stop accepting new turns
               evict   { tenantId, erase }       account moved away, or deleted

worker → box   mirror  { email, … }              email is now required
               ping    { ts, load: { running, queued, diskFreeMb } }
```

Rules on the box:

- A `mirror` or `notify` frame from a worker is dropped unless `email` is
  assigned to that worker. A compromised worker cannot write into accounts it
  does not serve.
- A worker whose `build` is below `minBuild` is welcomed but receives no
  placements.
- A worker reporting `sandbox: "none"` is treated as `single_tenant`
  regardless of how it was enrolled.

`ctx` is how the worker learns an account's settings without holding them:
provider, model and credential mode stay in the box's `user_llm_settings`
and travel with each request.

---

## 8. Routing and placement

### 8.1 Addressing

`provided` becomes a reserved host id.

| Request | Goes to |
|---|---|
| `/api/hosts/<hostId>/…` | that account's personal host (today's behaviour) |
| `/api/hosts/provided/…` | the account's assigned worker |
| relayable root path, e.g. `/api/sessions/…` | same as `provided` |
| everything else at the root | the box itself |

The third row is what keeps the shipped iOS build working: it sends root
paths and never learns that anything changed.

For a personal host almost everything is relayed, because the Mac is the
person's own. For a provided device the account lives on the box, so more
stays there:

| Relayed to the worker | Answered by the box |
|---|---|
| `/api/sessions/…`, `/api/chat`, `/api/extract-choices` | `/api/me`, `/api/auth/…`, `/api/account` |
| `/api/research/runs/…` | `/api/billing…`, `/api/admin/…` |
| `/api/deck…`, `/api/artifacts/…` | `/api/link/…`, `/api/hosts/…` |
| `/api/skills…`, `/api/agents…`, `/api/projects` | `/api/llm/…` (settings, providers, proxy) |
| | `/api/transcribe`, `/api/protocols/mcp…` |
| | `/api/folders`, `/api/fs/…` — refused: there are no folders to grant |

Deleting an account (`/api/account`) is answered by the box, which then sends
`evict { erase: true }` so the worker removes the tenant.

Both lists move to `@labee/contracts` so the box and every client share one
definition instead of the web client's private deny-list.

### 8.2 Placement

```
provided_assignments
  email      text pk
  tenant_id  text          "tnt_…", random
  worker_id  text          "wrk_…" | "builtin"
  state      text          "active" | "migrating"
  assigned_at
```

- First relayable request from an account with no row: choose among online,
  non-draining workers that have the needed engine, fewest tenants first.
- The assignment is sticky. The account's files are on that worker.
- Assigned worker offline: `GET`s for sessions are served from the mirror,
  exactly as for a sleeping Mac. Writes return `503` with a message that says
  the device is restarting, not that the person did something wrong.

### 8.3 The box as a worker of last resort

In-process execution on the box stays, as the worker named `builtin`.

```
LABEE_PROVIDED_EXEC = builtin            today's behaviour; the default
                    | pool               workers only; box runs nothing
                    | pool-then-builtin  new accounts go to workers
```

Accounts that already have files on the box keep a `builtin` assignment
until migrated. Rollout is therefore a flag flip, and rollback is the same
flag.

### 8.4 Capacity

A worker admits at most `capacity.maxTurns` running turns across all tenants.
At about 1 GiB per agent process, a 16 GB PC is good for roughly eight.
Beyond that a turn is queued on the worker with a `turn_queued` event whose
reason is `capacity`, so the client can say "waiting for a free slot" rather
than show a spinner. A research run counts as one turn for as long as it
runs.

---

## 9. Tenancy and sandbox

This part does not exist in any form today, and it decides whether a shared
worker is safe to run.

```
<data>/tenants/<tenantId>/
    deck/          the working directory
    skills/  protocols/
    config/claude/ CLAUDE_CONFIG_DIR for this tenant
    config/codex/  CODEX_HOME for this tenant
    labee.sqlite   this tenant's sessions
```

`tenantId` is random, not derived from the email, so a directory listing
reveals nothing.

### 9.1 Two processes, two levels of trust

| | Supervisor | Tenant container |
|---|---|---|
| Runs | The server: link, routes, `SessionRunner`, gateway | The engine CLI and everything it spawns |
| Holds | Worker credential, proxy tokens, every tenant's files | One tenant's directory, mounted at its real path so skill symlinks resolve |
| Network | The box only | Public internet; private, link-local and metadata ranges blocked; the gateway |
| Lifetime | The worker's | Started on a tenant's first turn, stopped when idle |

Every process start goes through one function, so nothing can forget the
sandbox:

```ts
interface SandboxDriver {
  id: "container" | "none";
  spawn(tenant: Tenant, cmd: string, args: string[], opts: { cwd: string; env: Env; limits: Limits }): ChildProcess;
}
```

`claudeRunner`, `codex.ts`, `research/agentTask.ts` and
`research/evaluator.ts` call `driver.spawn` instead of `child_process.spawn`.

### 9.2 What the container buys

| Threat | Stopped by |
|---|---|
| Tenant reads another tenant's files | Only its own directory is mounted. |
| Tenant scans the office LAN the PC sits on | Egress rules on the container network. |
| Tenant reads the worker credential or proxy tokens | They exist only in the supervisor. |
| Runaway process | CPU, memory, process-count and wall-clock limits per container. |
| Engine's own sandbox silently not starting | Irrelevant to the boundary; `failIfUnavailable` is set anyway. |

With the container as the boundary, the engine runs without permission
prompts inside it. `fullAccess` from a client is ignored on a provided
device: there is nothing outside the tenant directory to grant.

### 9.3 Where it runs

| Host OS | How |
|---|---|
| Linux | Rootless Podman or Docker. |
| Windows | Docker Desktop or Podman on WSL2. |
| macOS | Docker Desktop, or any Linux VM. |

One image holds the engine CLIs and the runtimes skills need. The supervisor
can run in a container too, given access to the container runtime's socket.

A worker with no container runtime reports `sandbox: "none"` and is limited
to a single tenant. That covers the App Review instance, which becomes the
first enrolled worker without changing how it runs.

---

## 10. Credentials

### 10.1 No keys on the worker

Provider keys stay on the box. The worker authenticates to the box proxy with
a token scoped to one account.

### 10.2 The turn-scoped inference gateway

Desktops put the proxy token in the CLI's environment. On a shared machine
that is not acceptable: the agent has a shell, and a prompt injection that
runs `env` and posts the result gives away an hour of that account's
inference. It is also already fragile — a research run computes its
credential once at start (`research/engine.ts:112`), from a cache that may be
45 minutes into a 60-minute token.

Instead the supervisor runs a small listener that only tenant containers can
reach:

```
engine  ──►  http://gateway/g/<nonce>/anthropic/v1/messages
                       │  nonce → { email, sessionId, turnId }
                       │  adds Authorization: Bearer <proxy token>
                       ▼
             https://labee.online/api/llm/anthropic/v1/messages
```

- The engine is given only the gateway URL. The nonce is useless off the
  machine and dies when the turn ends.
- The gateway fetches and refreshes proxy tokens itself
  (`POST /api/link/worker/proxy-token { email }`, authenticated with the
  worker credential; refused unless the account is assigned to that worker).
  A turn that runs for three hours no longer outlives its token.
- It is the same for every engine: anything that accepts a base URL works.
- The box can attribute usage to a session, turn and worker, not only to an
  account.

Considered and not chosen: the engines' own token helpers (`apiKeyHelper`
for claude, `[model_providers.x.auth] command` for codex). They solve expiry
but still hand a usable token to a process inside the sandbox, and each
engine needs its own.

### 10.3 Credential modes on a provided device

| Mode | On a provided device |
|---|---|
| `provided` | Proxy uses Labee's key. Metered, debits credits. Subject to §3.4. |
| `own_api_key` | Proxy uses the person's key, decrypted on the box. The key never reaches the worker. |
| `own_subscription` | Not available. A subscription login belongs on the person's own computer; the UI says so and points to linking a Mac. |

A tenant's engine config directory is created empty and never contains a
login. With only a base URL set, the claude CLI would otherwise prefer a
saved claude.ai login over the gateway.

---

## 11. Engines

```ts
interface EngineAdapter {
  id: string;                                   // "claude" | "claude-sdk" | "codex" | …
  probe(): Promise<{ available: boolean; version?: string }>;
  providers: string[];
  start(turn: EngineTurn, sandbox: SandboxDriver): ReadableStream<Uint8Array>;   // the existing SSE frames
}

interface EngineTurn {
  tenant: Tenant;
  cwd: string;
  systemPrompt: string;
  userPrompt: string;
  model: string;
  effort?: "low" | "medium" | "high";
  access: "read-only" | "workspace";
  mcp: McpServerSpec[];
  inference: Record<string, string>;            // provider → gateway base URL
}
```

- `prepareTurn` keeps everything that is engine-neutral — prompt assembly,
  skills and protocol linking, context files, mode text — and then hands an
  `EngineTurn` to the adapter the registry picks. The fixed chain at
  `turnBuilder.ts:659-726` becomes a lookup.
- The output contract is the event vocabulary clients already consume
  (`init`, `delta`, `tool_start`, `tool_input`, `tool_stop`, `tool_result`,
  `result`, `error`, `end`). An adapter's job is to translate into it.
- `probe()` runs at start-up; its results are the `engines` list in `hello`.
  The box uses it for placement and to tell clients which engines the
  selected device offers.

| Engine | Work needed |
|---|---|
| `claude` | Move the existing code behind the interface. |
| `claude-sdk` | Only if §3.4 goes that way. Same event mapping; the Agent SDK emits the same message stream. |
| `codex` | Switch from `-o file` to `codex exec --json` so tool activity is streamed. Add a provided path: a model provider in the tenant's `CODEX_HOME/config.toml` whose `base_url` is the gateway. Whether `codex exec` honours a custom provider is not stated in its documentation — check this first. |
| others | Gemini CLI, opencode and Cursor's CLI all have a streamed JSON mode. The first two also accept a custom base URL. One adapter each, or one shared adapter over the Agent Client Protocol, which those three speak natively and claude and codex do not. |

Adding a third *provider* touches more than the adapter. These assume
exactly two today:

| Assumption | Where | Change |
|---|---|---|
| `Provider` and `AgentEngine` are two-value literals | `packages/contracts/src/llm.ts:4`, `agent.ts:4` | Open strings, validated against what the device advertises. |
| Anything not `openai` is coerced to `anthropic`; anything not `codex` to `claude` | `llmSettings.ts:33`, `agents.ts:32,92,242,329` | Reject unknown values instead of coercing. |
| `user_llm_settings` has one column pair per provider | `llmSettings.ts:17-26` | One row per `(email, provider)`. |
| Two proxy routes, two base URLs in the token response | `llmProxy.ts:98-103`, `:303-336` | A table of upstreams; one route `/api/llm/:provider/*`. |
| Model catalog, billing provider type, research engine | `llm.ts:12-65`, `billing.ts:486`, `research/engine.ts:73` | Catalog comes from the adapter. |
| Engine pickers list Claude Code and Codex | `AgentEditor.tsx:31`, `LlmSettingsPanel.tsx:271` | Render what the device advertises. |

None of that is needed for claude and codex. It is the bill for "any other".

---

## 12. State and durability

Choosing cut A puts an account's files on the worker. Three layers, added in
order:

1. **Mirror** (exists). Transcripts survive a dead worker and stay readable.
2. **Local backup** (phase 2). Nightly `VACUUM INTO` plus an archive of
   `tenants/`, kept on the worker's volume. Protects against corruption, not
   against losing the machine.
3. **Snapshots** (phase 4). Per tenant, encrypted, uploaded through the link
   to storage the box controls; taken when a tenant goes idle. Reassigning an
   account is then: mark `migrating`, restore the snapshot on the new worker,
   mark `active`, `evict` from the old one.

Until layer 3 exists, losing a worker loses its tenants' deck files. That is
acceptable for an allow-listed pilot and not for general availability — the
phases in §15 are ordered accordingly.

Mirror rows for a worker are stored under host id `provided`, not the worker
id, so they stay valid when an account moves.

---

## 13. Clients

Nothing is required for the first release. Afterwards:

- `GET /api/link/hosts?include=provided` returns a first row
  `{ hostId: "provided", name: "Labee", kind: "provided", online, engines }`.
  The query parameter keeps the row away from the shipped build, which would
  otherwise list it next to its own hard-coded "This server (direct)".
- Mobile (`app/hosts.tsx`) and web (`RunsOnPanel.tsx`) drop their hard-coded
  first row and render the one from the server, with a real online state.
- The engine picker lists what the selected device advertises.
- When the provided device is offline, sessions open read-only with the same
  banner used for a sleeping Mac.

---

## 14. Operating it

- **Admin page** (`/admin/workers`): workers with state, build, engines, load
  and tenant count; create an enrollment key; drain; revoke; move an account.
- **Upgrades.** `drain` → wait for running turns → restart on the new image →
  reconnect. With one worker this is a short outage served from the mirror.
- **Logs.** A worker logs tenant ids, never emails or prompt text.

---

## 15. Phases

| Phase | Deliverable | Exit condition |
|---|---|---|
| 0 | Decide the Claude route (§3.4). Restore the subscription guard in the proxy. Relay lists in `@labee/contracts`. | Production proxy refuses subscription credentials. |
| 1 | `LABEE_MODE=worker`, enrollment, protocol v2, dispatcher behind `LABEE_PROVIDED_EXEC`, `provided` alias. `sandbox: "none"`, single tenant, allow-listed accounts. Per-account proxy tokens. | The App Review instance is an enrolled worker; the demo account runs on it from the unchanged iOS build. |
| 2 | Sandbox driver, tenant containers, inference gateway, the §3.2 list, local backup. | Two test accounts on one worker cannot read each other's files, reach the LAN, or obtain a token. |
| 3 | Engine registry; codex streamed and provided; clients read `engines`. | A provided account runs a codex turn with visible tool activity. |
| 4 | Several workers, placement, drain, snapshots, account migration, admin page. `pool` becomes the default. | Killing a worker loses no files. |
| 5 | Third engine and the provider generalisation in §11. | — |

---

## 16. Failure modes

| Event | Behaviour |
|---|---|
| Worker loses network mid-turn | The turn keeps running locally. On reconnect the worker resyncs summaries and messages. |
| Worker misses heartbeats | Marked lost after 2.5 intervals, as hosts are today. Its turns are not re-run elsewhere: they have side effects, and the worker may still be running them. |
| Worker process dies mid-turn | On restart `recoverInterrupted` ends the turn with an error event, as today. |
| Box restarts | Workers reconnect with backoff; running turns are unaffected. Assignments survive because they are persisted. |
| Worker credential stolen | Revoke it. The thief could have impersonated that worker for its assigned accounts only. |
| Enrollment key leaked | Single use and 24 h expiry bound the damage; a worker enrolled with it shows up in the admin list and can be revoked. |
| Account over its credit | The proxy returns `402`; the turn ends with that message. No change. |

---

## 17. Open questions

1. **Which Claude route (§3.4)?** Everything else can proceed in parallel,
   but phase 1 should not ship provided Claude turns on more machines before
   this is settled.
2. **Who operates the third PC?** The design assumes Labee. If a lab or a
   customer may host a worker for its own members, enrollment needs an
   organisation scope, and that should be decided before the tables in §6
   are created.
3. **Is losing deck files acceptable during the pilot?** If not, snapshots
   move from phase 4 to phase 2.
4. **Should `own_api_key` work on a provided device at all?** It is cheap to
   support through the proxy, but it means Labee's hardware runs turns that
   Labee does not bill for.
5. **Which third engine first?** The adapter interface is settled either way;
   the choice only decides which adapter gets written.
