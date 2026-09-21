# Labee Mobile — design

A phone + iPad companion that lets a user **attach to the same long-running
agent session from any device**, watch and steer it, and **talk to it by
voice**. This document is the design; nothing here is implemented yet.

Status: implemented 2026-09-19 (see [mobile-companion-plan.md](./mobile-companion-plan.md) for what shipped and what is still open). Author: Labee team.
Prior art and the deltas it suggests: [mobile-companion-survey.md](./mobile-companion-survey.md) §5.

---

## 1. Goals and non-goals

**Goals**

1. A session started on the Mac is visible on the phone within seconds,
   live, with full history — and vice versa.
2. A turn keeps running when every client disconnects. Closing the laptop lid
   or locking the phone never kills the agent.
3. Voice is a first-class input on the phone: push-to-talk, hands-free, and
   read-aloud of what the agent says. Approvals ("approve the brief", "yes,
   run it") work by voice.
4. Research runs get the same treatment: attach, watch stages, answer gates,
   see cost, read the paper — from the phone.
5. iPad is a real workstation layout, not a stretched phone.

**Non-goals (v1)**

- Running the agent *on* the phone, or on the box. The agent always runs on
  the user's Mac (embedded desktop server). labee.online is only the relay,
  push sender, and metered voice backend; it never executes a session.
- Editing files or the canvas from the phone. Read-only artifact viewing only.
- Android. The design is portable, but v1 targets iOS/iPadOS.

---

## 2. What the codebase does today (and what blocks the goals)

| Area | Today | Blocks |
|---|---|---|
| Chat session | Transcript in browser `localStorage` (`apps/web/src/store/chat-store.ts`). Each turn spawns `claude -p … --no-session-persistence` and streams SSE back on the same HTTP response (`apps/server/src/routes/chat.ts`, `buildChatStream`). `cancel()` on the response **kills the CLI**. | Goals 1, 2. The session is bound to one JS context; a second device has nothing to attach to. |
| Research run | Server-owned. `runs` + `events` tables, `subscribeRun` live tail, `GET /runs/:id/events?after=seq` replays from a sequence number, `POST /runs/:id/gate`, `POST /runs/:id/cancel` (`apps/server/src/routes/research.ts`). | Nothing. This is already attachable and is the model to copy. |
| Host reachability | Desktop forks the server on `127.0.0.1:<free port>` (`apps/desktop/src/main.ts`). Not reachable from a phone. The desktop already keeps a labee.online session in `remote-session.txt` and calls the box for proxy tokens, transcription, and skill sync. | Goal 1 for desktop-hosted sessions. |
| Voice | Push-to-dictate in the composer: `MediaRecorder` → `POST /api/transcribe` (OpenAI STT, `useDictation.ts`). No text-to-speech. | Goal 3 partly. |
| Auth | Sealed cookie `monterey_session` (30-day), password or Google OAuth with a loopback flow for desktop. | Fine; phone reuses it. |
| Notifications | None. | Goal 2's "come back later" half. |

The single most valuable change is **server-owned chat sessions** (§4). It
unblocks mobile and also fixes a desktop pain point: a page reload today loses
the live stream.

---

## 3. Architecture

```
  iPhone / iPad (Labee Mobile)
        │  HTTPS + SSE          (voice: audio up, text/audio down)
        ▼
  ┌──────────────────────────── labee.online (box) ────────────────────────────┐
  │  Relay only — no agent runs here.  /api/transcribe  /api/speak  APNs      │
  │  Session mirror: read-only copy of desktop session events (§5.4)          │
  │                                                                            │
  │  Device Link relay: /api/link/host (WS, from desktops) ──┐                 │
  │                     /api/hosts/:hostId/*  (from phones) ─┤ tunnel          │
  └──────────────────────────────────────────────────────────┼─────────────────┘
                                                             │ outbound WS
                                                             ▼
  ┌────────────────────────── user's Mac (Labee desktop) ────────────────────┐
  │  embedded @labee/server on 127.0.0.1                                     │
  │  SessionRunner: owns claude/codex children, persists events to SQLite    │
  │  LinkClient: dials the box, serves tunneled requests as local requests   │
  └──────────────────────────────────────────────────────────────────────────┘
```

Three building blocks, in dependency order:

1. **Server-owned sessions** (§4) — sessions and their event log live on the
   host that runs the agent, with the research-run replay/tail pattern.
2. **Device Link** (§5) — the phone reaches a desktop-hosted session through
   the box, which also keeps a read-only mirror of the event log.
3. **Mobile app + voice** (§6–§8) — an Expo app that speaks the same API the
   web client will use, with native audio, push, and Live Activities.

---

## 4. Server-owned sessions

### 4.1 Data model (SQLite via drizzle, next to `research` tables)

```
sessions
  id            text pk          "ses_…"
  email         text             owner
  agent_id      text null        saved agent preset (cwd, skills, engine)
  title         text             first user message, editable
  cwd           text
  engine        text             "claude" | "codex"
  provider      text             "anthropic" | "openai"
  model         text null
  status        text             "idle" | "running" | "awaiting_input" | "error"
  active_turn   text null        turn id while running
  last_seq      integer          highest persisted event seq
  created_at, updated_at, archived_at

session_events
  session_id, seq (pk together), ts, type, data (json)

session_messages           -- the durable transcript (what gets re-sent to the CLI)
  session_id, idx (pk together), role, content, created_at
```

`session_events` uses the **same event vocabulary the web client already
consumes** from `claudeStream.ts` (`init`, `message_start`, `thinking_*`,
`text_delta`, `tool_use_*`, `tool_result`, `status`, `end`, `error`) plus a
handful of session-level events:

```
turn_started      { turnId, userMessage, skillSlugs, contextFiles, voice }
turn_ended        { turnId, stats }                 -- cost/duration, from `result`
question_asked    { turnId, toolUseId, questions }  -- AskUserQuestion (already detected)
question_answered { turnId, answers, device }
turn_cancelled    { turnId, device }
session_renamed   { title }
```

Retention: `thinking_delta` / `text_delta` are persisted only until the turn
ends, then compacted into the final `assistant` message (the web store already
drops activity on persist for the same quota reason). Tool blocks keep name +
truncated result (8 KB) so the phone can show "what it did".

### 4.2 Runner

`apps/server/src/services/sessionRunner.ts` — a registry like
`research/runtime`'s `getRunHandle` / `subscribeRun`:

- `startTurn(sessionId, input)` builds the prompt exactly as `chat.ts` does
  today (transcript + context files + skills), spawns via `spawnClaudeStream`,
  and **owns the child**. Events are appended to `session_events` and fanned
  out to subscribers. The HTTP request that started the turn returns `202
  { turnId }` immediately.
- Client disconnects never kill the child. Only `cancelTurn` does.
- `question_asked` sets `status = awaiting_input` and, as today, kills the CLI
  (it cannot run `AskUserQuestion` headless). The answer becomes the next
  user message and starts a new turn — the same flow `chat-store` implements
  client-side now, moved server-side so *any* device can answer.
- One running turn per session; a second `startTurn` returns `409`.
- Later optimisation (not v1): keep the CLI `session_id` from the `init` event
  and use `--resume` so the transcript is not re-sent every turn.

### 4.3 API

```
POST   /api/sessions                      { agentId?, title? }        → Session
GET    /api/sessions?status=running       list, newest first, with status + lastSeq
GET    /api/sessions/:id                  Session + messages (paged)
PATCH  /api/sessions/:id                  { title?, archived? }
DELETE /api/sessions/:id

POST   /api/sessions/:id/turns            ChatRequest (as today) + { voice?: bool }
                                          → 202 { turnId }      409 if running
POST   /api/sessions/:id/turns/:turnId/cancel
POST   /api/sessions/:id/answer           { toolUseId, answers }   (AskUserQuestion)

GET    /api/sessions/:id/events?after=seq  SSE, event: "session_event",
                                          id: seq, replay then live tail,
                                          ?coalesce=ms merges text deltas (mobile)
GET    /api/sessions/:id/artifacts        deck/cwd files touched this session (read-only)
```

`GET …/events` is a copy of `runEventsRoute` (replay-before-tail with a
seen-set, 25 s heartbeat, terminal frame on idle sessions). `Last-Event-ID`
is honoured so iOS reconnects resume without loss.

### 4.4 Web client migration

`chat-store.ts` becomes a cache of the server session: on load it fetches
`/api/sessions/:id` and subscribes to `/events?after=lastSeq`. The reducer that
turns SSE events into `messages[]` + `activity[]` is extracted to a new
`packages/session-core` (framework-free TS) so the mobile app uses the same
code. localStorage keeps only "last opened session id" and UI prefs.

This step ships on its own before any mobile work and is a visible desktop
improvement (reload-safe streaming, sessions list, cross-window continuity).

---

## 5. Device Link (reaching a desktop-hosted session)

Desktop sessions run on the user's Mac behind NAT. The box is the rendezvous.

### 5.1 Why a relay, not a VPN or LAN-only

- The desktop **already** holds a box session (`LABEE_REMOTE_SESSION_FILE`)
  and dials the box for proxy tokens, transcription, and skills. Reusing that
  identity means zero new sign-ins: the phone signs in to labee.online and
  sees its Macs.
- Works over cellular, hotel Wi-Fi, etc. LAN direct (Bonjour) is a later
  latency optimisation, not the base case.
- The traffic is SSE JSON and small audio clips; a Lightsail box handles it.

### 5.2 Protocol

```
Desktop → box   WSS /api/link/host   (cookie: box session)
                hello  { hostId, name: "Martin's MacBook Pro", version, caps: ["sessions","research","transcribe"] }
                box registers host online for that account; heartbeats every 20 s

Phone → box     GET/POST https://labee.online/api/hosts/:hostId/api/sessions/…
                box authenticates the phone (same account), then tunnels:

box → desktop   { id, method, path, headers, body }            request frame
desktop → box   { id, status, headers } · { id, chunk } · { id, end }   (streams SSE as chunks)
phone ← box     the reassembled HTTP response / SSE stream
```

The desktop server handles a tunneled request as a normal loopback request
from the local (single) desktop user. Identity check: the box only forwards
for the account whose session the desktop presented in `hello`; the desktop
verifies `hello` was acknowledged for its own linked email.

### 5.3 Trust and safety

- **First attach from a new device**: the Mac shows a modal "iPhone 16 wants
  to attach — approve?" (like AirDrop). The phone shows a 6-digit code the
  user confirms on the Mac. Approved devices are listed in Settings › Devices
  on both ends, with revoke.
- Per-device tokens, revocable; a revoked device gets `403` at the box, never
  reaches the Mac.
- **Full Access is off for remote clients by default.** A remote turn runs
  with `fullAccess: false` unless the user toggles it per session, and the Mac
  shows a persistent badge while a remote device has Full Access.
- The box sees plaintext tunnel traffic (it is the same operator that already
  proxies inference in "provided" mode). End-to-end encryption between phone
  and Mac is a possible later step, not v1.
- Rate-limit `/api/hosts/*` per device; cap tunneled body at 25 MB (the
  transcribe limit).

### 5.4 Session mirror on the box

The desktop writes every persisted `session_events` row through the Device
Link to the box (`mirror` frames, batched, at most once per 250 ms). The box
stores them per account and serves `GET /api/hosts/:hostId/sessions/*` reads
from the mirror, so the phone can open a transcript even while the Mac is
asleep. Only writes — new turn, cancel, answer, diff request — are tunneled
to the Mac, and they fail fast with `503 host offline` when it is not
connected. The mirror is what Claude Code Remote Control and GitHub do; it
keeps relay traffic to one write path instead of one SSE per phone screen.

There is no box-run session: a user on the web at labee.online sees the same
mirrored desktop sessions, read-only unless a Mac is online.

---

## 6. The app

### 6.1 Platform

**Expo (React Native) + TypeScript**, sharing `@labee/contracts` and the new
`packages/session-core` reducer with the web client. Native pieces via Expo
modules: `expo-audio` (record + playback), `expo-speech` (on-device TTS),
`expo-notifications` (APNs), plus one small Swift module for Live Activities.

Why not SwiftUI: zero code sharing with the event reducer, contracts, and
research views, and a second implementation of every SSE nuance
(AskUserQuestion recovery, partial tool input). Why not a PWA: no background
audio, no Live Activities, unreliable SSE in background, weaker push. A
responsive pass on the existing web app is still worth doing (§9 phase 0) as
the "no app installed" fallback.

### 6.2 Navigation

```
Home (Sessions)  ──►  Session  ──►  Voice mode (full-screen overlay)
      │                   └──►  Activity / Files (sheet)
      ├──►  Runs  ──►  Run  ──►  Stage / Gate / Paper / Claims
      ├──►  Inbox  (questions + gates waiting on you, across Macs)
      └──►  Settings  (Hosts & devices, Voice, Notifications, Account)
```

### 6.3 Phone screens

**Home — Sessions**

```
┌──────────────────────────────┐
│ Labee                 ⚙  🔔2 │
│ ┌──────────────────────────┐ │
│ │ ⏳ Waiting on you (2)    │ │   ← Inbox strip, only when non-empty
│ └──────────────────────────┘ │
│ RUNNING                      │
│ ● MoE load balancing study   │   green dot = running, "Mac" chip = host
│   Mac · solver · 14 min      │
│ ● Protocol digest for lab    │
│   Mac · writing              │
│ RECENT                       │
│   Fix dev remote session     │
│   Mac · idle · 2 h ago       │
│   …                          │
│                              │
│         ┌────────────┐       │
│         │  🎤  New   │       │   ← long-press: pick host/agent
│         └────────────┘       │
└──────────────────────────────┘
```

**Session**

```
┌──────────────────────────────┐
│ ‹ Sessions    MoE study   ⋯  │
│ Mac · running · $4.12        │
├──────────────────────────────┤
│ You  (voice)                 │
│  what did the auditor say    │
│                              │
│ Labee                        │
│  The auditor passed three of │
│  five dossiers…              │
│  ┌────────────────────────┐  │
│  │ ▸ Read 3 files · Grep  │  │   ← collapsed activity strip, tap to expand
│  │   Running tests…   ●   │  │
│  └────────────────────────┘  │
│                              │
├──────────────────────────────┤
│ [ Aa ]  ( 🎤 hold to talk )  │   ← hold = push-to-talk, tap = hands-free
│                     ⏹ Stop   │      Stop cancels the running turn
└──────────────────────────────┘
```

**Voice mode** (full-screen, entered by tapping the mic or from CarPlay-style
"hands-free" toggle)

```
┌──────────────────────────────┐
│               ✕              │
│                              │
│        ◯  ◯  ◯  ◯            │   listening / thinking / speaking waveform
│                              │
│   "Approve the brief and     │   live transcript of what you said
│    move on"                  │
│                              │
│   Approving the experiment   │   what it is saying (sentence-by-sentence)
│   brief. Discovery starts    │
│   with the Opus ideator…     │
│                              │
│  Reading 2 files · 12 s      │   one-line activity, spoken only if >20 s
│                              │
│   ( tap to interrupt )       │
└──────────────────────────────┘
```

**Question / gate card** (in Session and in Inbox; also the push
notification's expanded view)

```
┌──────────────────────────────┐
│ Labee is asking              │
│ Which evaluator should the   │
│ discovery stage use?         │
│  ○ Command (objective)       │
│  ○ LLM rubric                │
│  ○ Other…                    │
│ [ 🎤 answer by voice ] [Send]│
└──────────────────────────────┘
```

**Run** — stages as a vertical timeline (investigate › discover › write ›
verify) with the live task list under the current stage, cost and elapsed
in the header, and the gate card pinned when `awaiting_gate`. Tabs: Timeline ·
Paper · Claims (supported / partial / unsupported counts) · Evidence.

### 6.4 iPad

Three-column `NavigationSplitView`-style layout, all columns live:

```
┌────────────┬──────────────────────────────┬────────────────────┐
│ Sessions   │ Transcript                   │ Activity           │
│ ● MoE …    │                              │ ▸ tool calls       │
│ ● Digest   │  …                           │ ▸ files touched    │
│   Fix dev  │                              │ ▸ run stages       │
│            │                              │ ▸ cost / stats     │
│ Runs       │                              │                    │
│ Inbox (2)  ├──────────────────────────────┤                    │
│            │ [Aa] (🎤 hold)        ⏹ Stop │                    │
└────────────┴──────────────────────────────┴────────────────────┘
```

Keyboard shortcuts (⌘N new session, ⌘. stop, space = push-to-talk while
composer is empty), Stage Manager / Split View friendly, drag a file from
Activity into Files app (read-only export).

---

## 7. Voice

### 7.1 Modes

| Mode | Trigger | Behaviour |
|---|---|---|
| Push-to-talk | hold mic | record while held, transcribe on release, send. |
| Hands-free | tap mic / Voice mode | VAD-segmented recording; each utterance is sent when the user pauses >1.2 s; agent replies are spoken; barge-in supported. |
| Read-aloud | per session toggle | spoken replies even when typing. |

### 7.2 Speech-to-text

v1 reuses `POST /api/transcribe` (tunneled or direct). Same key routing as
today (own OpenAI key › forward to box › box key). Latency is one round trip
per utterance (1–3 s), acceptable for push-to-talk.

v2 streams: `WSS /api/transcribe/stream` backed by OpenAI Realtime
transcription, showing partial text while speaking. Only the box implements
it; desktops forward.

### 7.3 Text-to-speech

v1: **on-device** (`AVSpeechSynthesizer` via `expo-speech`). Free, offline,
works on the lock screen, no new server code. The client feeds it sentence
chunks as `text_delta` events arrive (split on `.`, `?`, `!`, newlines; hold
partial sentences).

v2: `POST /api/speak { text } → audio/mpeg` (OpenAI TTS, box-only, metered
like transcription) selectable in Settings › Voice.

### 7.4 What gets spoken

- Assistant text: yes, sentence by sentence, code blocks replaced with "code
  block, N lines".
- Tool activity: not by default. In hands-free mode, a throttled status line
  ("Reading files… running tests…") only when a turn is quiet for >20 s.
- Questions and gates: always, followed by the options.
- Turn requests carry `voice: true`; the server appends to the system prompt:
  *"The user is speaking and listening by voice. Begin with a one- or
  two-sentence spoken summary, then details."* This keeps replies listenable
  without a second model call.

### 7.5 Voice commands (client-side, before sending)

A small grammar handled on the phone so common control words never become a
turn: "stop" / "cancel" → cancel turn; "approve" / "reject" while a gate or
question is pending → answers it; "new session"; "read that again". Anything
else is a user message.

### 7.6 Interruptions

Speaking while TTS plays stops playback immediately (barge-in). Saying "stop"
also cancels the running turn (`POST …/cancel`). Audio session is
`playAndRecord` with echo cancellation so the mic does not hear the speaker.

---

## 8. Notifications and background

iOS suspends SSE in the background within ~30 s. The design assumes it:

- Every screen resumes from `lastSeq` on foreground (`?after=`), so nothing
  is lost.
- **APNs** (box-only; desktops relay `notify` frames up the Device Link):
  `question_asked`, `gate_waiting`, `turn_ended` (if app is backgrounded),
  `error`, run `completed` / `failed`, cost crosses a user threshold.
  Notifications are actionable (Approve / Reject / Answer… opens the card).
- **Live Activity** (Dynamic Island + lock screen) for a running session or
  research run: stage, elapsed, cost, and a Stop action. Updated via APNs push
  tokens, max one per session.
- Hands-free voice mode keeps the app active with a background-audio session
  while the user is in Voice mode.

---

## 9. Phases

| Phase | Deliverable | Notes |
|---|---|---|
| 0 | Responsive pass on `apps/web` (Session + Run pages at 400 px), viewport + PWA manifest | Groundwork for the phone-browser fallback in phase 2. |
| 1 | **Server-owned sessions** (§4) + web client migration + `packages/session-core` | Largest step; ships value on desktop alone. |
| 2 | **Device Link** (§5) on box and desktop, device approval UI, Devices settings | Phone browser can now open desktop sessions via `labee.online/h/<host>/…`. |
| 3 | **Expo app v1**: Sessions, Session, Run, Inbox; push-to-talk via `/api/transcribe`; on-device TTS; APNs for questions/gates | First TestFlight. |
| 4 | Hands-free mode, barge-in, voice commands, Live Activities, iPad three-column layout | |
| 5 | Streaming STT, server TTS, LAN direct (Bonjour) path, `--resume` optimisation | |

---

## 10. Risks and open questions

- **Event volume over the relay.** `text_delta` at token rate through the box
  is wasteful on cellular. `?coalesce=250` merges deltas server-side for mobile
  clients; LAN clients keep full rate.
- **Session event storage growth.** Compaction at `turn_ended` (§4.1) keeps
  the table proportional to message count, not token count.
- **Two devices sending at once.** One running turn per session, `409` on the
  second; the UI shows "Mac is typing…" presence from `turn_started.device`.
- **Mac asleep.** A desktop-hosted session is only reachable while the Mac is
  awake and the app is running. The host row shows "offline" and the phone
  shows the mirrored transcript read-only with a "Mac is asleep" banner;
  a "Keep Mac awake while devices are attached" toggle (Electron
  `powerSaveBlocker`) is the mitigation. Wake-on-LAN is out of scope.
- **Codex engine.** `codexExecStream` sessions go through the same runner;
  parity of the event vocabulary needs checking once §4 exists.
- **Cost of voice.** STT is metered on the box for "provided" users; the app
  shows per-session voice minutes in the cost line.
- **Open:** should the box be able to *start* a turn on the Mac while no
  desktop window is open (headless embedded server)? Recommended yes, behind
  a Settings › Devices toggle "Allow remote sessions while Labee is in the
  menu bar".
