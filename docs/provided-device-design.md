# Provided device — design

Make "Labee provided" a real **device**: a machine Labee operates that dials
the box, registers itself, and runs sessions for accounts that have no
computer of their own. It can sit anywhere — a spare PC behind NAT, a cloud VM
— and offers whichever engines are installed on it (claude, codex, others).

Status: design only, nothing here is implemented. Written 2026-09-27.
Builds on [mobile-companion-design.md](./mobile-companion-design.md) §5
(Device Link).

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
| 2 | **Accounts are separated by directory only.** Every account's turn runs as the same OS user, and `fullAccess` defaults to on, which maps to `bypassPermissions`. One account's agent can read another's deck. | `turnBuilder.ts:508`, `:556`, `:650` |
| 3 | **Provided is not addressable.** Clients special-case "no host". It has no online/offline state, no engine list, and cannot be moved or drained. | `apps/mobile/app/hosts.tsx:37`, `RunsOnPanel.tsx:53` |
| 4 | **Engines are hard-wired.** `prepareTurn` branches on `claude \| codex \| openai`. Codex runs only on a ChatGPT login, returns only its final text, and has no provided path. | `turnBuilder.ts:659-726`, `codex.ts:229` |
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
- Using a Claude or ChatGPT subscription on a provided device (§10.3).
- End-to-end encryption between client and worker.

---

## 3. What the code already gives us

| Piece | State | Consequence |
|---|---|---|
| Tunnel (`req` / `res` / `chunk` / `end` / `abort`) | Host-agnostic. The box forwards any path; the host replays it against its loopback server. | Reused as is. |
| Host auth on a tunneled request | The host accepts whatever email the box names, if the per-process link secret matches (`httpKit.ts:44`). | A host can already serve any account. Nothing to change on the replay path. |
| Host registration | Bound to one account: the link token is sealed from a user's session cookie (`routes/link.ts:38`), and the registry is keyed `email → hostId` (`deviceLink/hosts.ts:24`). | This is the part that needs a second form. |
| Mirror | Keyed `(email, host_id, id)`; the email comes from the connection, not the frame (`routes/link.ts:127`). | Frames from a worker must carry the email. |
| Provided inference off-box | Exists for desktops: mint a proxy token, point the CLI at `/api/llm/anthropic` (`llmSettings.ts:209`, `llm.ts:73`). Token is per account, valid one hour, placed in the CLI's environment. | The mechanism is right; the token handling is not good enough for a shared machine (§10). |
| Server-owned sessions, queue, replay-then-tail SSE | Done. | The worker runs the same `SessionRunner`. |

<!-- RESEARCH:INTERNAL -->

### 3.1 Prior art

<!-- RESEARCH:EXTERNAL -->

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
  │  @labee/server in LABEE_MODE=worker, loopback only                           │
  │   ├ LinkClient        worker credential, protocol v2                         │
  │   ├ SessionRunner     unchanged                                              │
  │   ├ engine registry   claude · codex · …                                     │
  │   ├ inference gateway 127.0.0.1, one nonce per turn                          │
  │   └ tenants/<id>/     deck, skills, sessions — one sandbox per account       │
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
enrollment key   lwe_…   admin creates it on the box; single use by default, expires in 24 h
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
                         sandbox: "container+bwrap" | "seatbelt" | "none",
                         engines: [ { id: "claude", version: "…", providers: ["anthropic"] },
                                    { id: "codex",  version: "…", providers: ["openai"] } ],
                         capacity: { maxTurns: 4 } }

box → worker   welcome { workerId, pingMs, minBuild, limits }
               req     { …, user, ctx: { provider, model, credentialMode, plan } }
               drain   { }                       stop accepting new turns

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
| everything else at the root (auth, billing, link, push, LLM proxy) | the box itself |

The third row is what keeps the shipped iOS build working: it sends root
paths and never learns that anything changed.

The list of relayable paths exists today only in the web client. It moves to
`@labee/contracts` so the box and every client share one definition.

### 8.2 Placement

```
provided_assignments
  email      text pk
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
Beyond that a turn is queued on the worker with a `turn_queued` event whose
reason is `capacity`, so the client can say "waiting for a free slot" rather
than show a spinner. Research runs count as one turn for as long as they run.

---

## 9. Tenancy and sandbox

This is the part that does not exist in any form today, and the part that
decides whether a shared worker is safe to run.

```
<data>/tenants/<tenantId>/
    home/          HOME for every process in this tenant
    deck/          the working directory
    skills/  protocols/
    labee.sqlite   this tenant's sessions
```

`tenantId` is a random id the box assigns, not the email, so a directory
listing reveals nothing.

Two boundaries, each protecting something different:

| Boundary | Protects | Mechanism |
|---|---|---|
| Machine | The PC and the network it sits on | The worker ships as a container image. No host mounts except its data volume. Egress to private, link-local and metadata address ranges is blocked, so an agent cannot scan the office LAN the PC is plugged into. |
| Tenant | Accounts from each other | Each turn runs under a per-tenant uid inside a filesystem sandbox: the tenant directory is writable, the engine install is read-only, everything else is invisible. CPU, memory, process-count and wall-clock limits per turn. |

<!-- RESEARCH:SANDBOX -->

With the sandbox as the boundary, the engine itself can run without
permission prompts inside it. `fullAccess` from a client is ignored on a
provided device: there is nothing outside the tenant directory to grant.

A worker run natively, without the container, is allowed only as
`single_tenant`. That covers the App Review instance, which becomes the first
enrolled worker.

---

## 10. Credentials

### 10.1 No keys on the worker

Provider keys stay on the box. The worker authenticates to the box proxy with
a token scoped to one account, as desktops already do.

### 10.2 The turn-scoped inference gateway

Desktops put the proxy token in the CLI's environment. On a shared machine
that is not acceptable: the agent has a shell, and a prompt injection that
runs `env` and posts the result gives away an hour of that account's
inference.

Instead the worker process runs a small listener on loopback:

```
engine  ──►  http://127.0.0.1:<port>/g/<nonce>/anthropic/v1/messages
                       │  nonce → { email, sessionId, turnId }
                       │  adds Authorization: Bearer <proxy token>
                       ▼
             https://labee.online/api/llm/anthropic/v1/messages
```

- The engine is given only the loopback URL. The nonce is useless off the
  machine and dies when the turn ends.
- The gateway fetches and refreshes proxy tokens itself
  (`POST /api/link/worker/proxy-token { email }`, authenticated with the
  worker credential; refused unless the account is assigned to that worker).
  A turn that runs for three hours no longer outlives its token.
- It is the same for every engine: anything that accepts a base URL works.
- The box can attribute usage to a session, turn and worker, not only to an
  account.

### 10.3 Credential modes on a provided device

| Mode | On a provided device |
|---|---|
| `provided` | Proxy uses Labee's key. Metered, debits credits. |
| `own_api_key` | Proxy uses the person's key, decrypted on the box. The key never reaches the worker. |
| `own_subscription` | Not available. A subscription login belongs on the person's own computer; the UI says so and points to linking a Mac. |

**Prerequisite.** Anthropic's terms do not allow a service to route users'
requests through a Pro or Max credential. The guard for this in
`routes/llmProxy.ts:78` is commented out, and the note in memory says
production inference runs on `LABEE_ANTHROPIC_OAUTH_TOKEN`. A pool of workers
would multiply that. Provided inference needs a Console API key before this
ships, and a worker must never have a `claude` or `codex` login of its own.

---

## 11. Engines

```ts
interface EngineAdapter {
  id: string;                                   // "claude" | "codex" | …
  probe(): Promise<{ available: boolean; version?: string }>;
  providers: Provider[];
  start(turn: EngineTurn): ReadableStream<Uint8Array>;   // the existing SSE frames
}

interface EngineTurn {
  cwd: string;
  systemPrompt: string;
  userPrompt: string;
  model: string;
  effort?: "low" | "medium" | "high";
  access: "read-only" | "workspace";
  mcp: McpServerSpec[];
  inference: { anthropicBaseUrl: string; openaiBaseUrl: string };   // gateway URLs
}
```

- `prepareTurn` keeps everything that is engine-neutral — prompt assembly,
  skills and protocol linking, context files, mode text — and then hands an
  `EngineTurn` to the adapter the registry picks. The three branches at
  `turnBuilder.ts:659-726` become three adapters.
- The output contract is the event vocabulary clients already consume
  (`init`, `delta`, `tool_start`, `tool_input`, `tool_stop`, `tool_result`,
  `result`, `error`, `end`). An adapter's job is to translate into it.
- `probe()` runs at start-up; its results are the `engines` list in `hello`.
  The box uses it for placement and to tell clients which engines the
  selected device offers.
- An agent's `engine` field becomes an adapter id rather than a two-value
  enum.

| Engine | Work needed |
|---|---|
| claude | Move the existing code behind the interface. Inference via the gateway. |
| codex | Switch to streamed JSON events so tool activity shows up, and add a provided path: a model provider entry pointing at the gateway. |
| others | One adapter each. |

<!-- RESEARCH:ENGINES -->

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
   mark `active`.

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

- **Packaging.** One image containing the server bundle, the engine CLIs and
  the runtimes skills need. Linux natively; Windows and macOS through a
  container runtime.
- **Admin page** (`/admin/workers`): workers with state, build, engines, load
  and tenant count; create an enrollment key; drain; revoke; move an account.
- **Upgrades.** `drain` → wait for running turns → restart on the new image →
  reconnect. With one worker this is a short outage served from the mirror.
- **Logs.** A worker logs tenant ids, never emails or prompt text.

---

## 15. Phases

| Phase | Deliverable | Exit condition |
|---|---|---|
| 0 | Provided inference on a Console API key. Relayable-path list in `@labee/contracts`. | Proxy refuses subscription credentials in production. |
| 1 | `LABEE_MODE=worker`, enrollment, protocol v2, dispatcher behind `LABEE_PROVIDED_EXEC`, `provided` alias. Native, `single_tenant`, allow-listed accounts. | The App Review instance is an enrolled worker; the demo account runs on it from the unchanged iOS build. |
| 2 | Container image, tenant sandbox, inference gateway, local backup. | Two test accounts on one worker cannot read each other's files or reach the LAN. |
| 3 | Engine registry; codex streamed and provided; clients read `engines`. | A provided account runs a codex turn with visible tool activity. |
| 4 | Several workers, placement, drain, snapshots, account migration, admin page. `pool` becomes the default. | Killing a worker loses no files. |

---

## 16. Failure modes

| Event | Behaviour |
|---|---|
| Worker loses network mid-turn | The turn keeps running locally. On reconnect the worker resyncs summaries and messages. |
| Worker process dies mid-turn | On restart `recoverInterrupted` ends the turn with an error event, as today. |
| Box restarts | Workers reconnect with backoff; running turns are unaffected. |
| Worker credential stolen | Revoke it. The thief could have impersonated that worker for its assigned accounts only. |
| Enrollment key leaked | Single use and 24 h expiry bound the damage; a worker enrolled with it shows up in the admin list and can be revoked. |
| Account over its credit | The proxy returns `402`; the turn ends with that message. No change. |

---

## 17. Open questions

1. **Who operates the third PC?** The design assumes Labee. If a lab or a
   customer may host a worker for its own members, enrollment needs an
   organisation scope, and that should be decided before the tables in §6
   are created.
2. **Is losing deck files acceptable during the pilot?** If not, snapshots
   move from phase 4 to phase 2.
3. **Should `own_api_key` work on a provided device at all?** It is cheap to
   support through the proxy, but it means Labee's hardware runs turns that
   Labee does not bill for.
4. **Which third engine first?** The adapter interface is settled either way;
   the choice only decides which adapter gets written.
