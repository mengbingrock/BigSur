# Mobile companion — survey of existing products

Companion to [mobile-companion-design.md](./mobile-companion-design.md).
What popular products do for "attach to a long-running agent session from a
phone" and "talk to an agent by voice", how they implement it, and what that
implies for Labee. Surveyed 2026-09-19 from vendor docs, changelogs, app-store
listings, and source repos; details marked *(secondary)* come from third-party
write-ups and should be verified before being relied on.

---

## 1. The landscape in one table

| Product | Agent runs on | Phone reaches it via | Pairing | Transcript kept on | Voice | Push | Open source |
|---|---|---|---|---|---|---|---|
| **Claude Code Remote Control** (Anthropic) | user's machine (`claude` process) | Anthropic API relay, TLS | session URL / QR, same claude.ai account | Anthropic servers while connected | via Claude app voice mode (text chat), not RC-specific | yes, "Claude decides" + action-required | no |
| **Codex mobile** (OpenAI, in ChatGPT app) | user's Mac (Codex app) or SSH devbox via Mac | OpenAI relay; E2E encrypted *(secondary)* | QR from Codex app, MFA/SSO | host; relay sees metadata only *(secondary)* | ChatGPT voice not wired to Codex threads | yes, approval gates + completion | no |
| **GitHub Copilot remote control** | user's machine (Copilot CLI / VS Code) | GitHub servers | `/remote on` + QR | GitHub | no | yes (GitHub Mobile) | no |
| **Cursor cloud agents + mobile app** | Cursor cloud (or local via Remote Control) | Cursor servers | account login | Cursor | no | yes; Live Activities for up to 8 agents | no |
| **Happy** (slopus/happy) | user's machine (`happy` wraps `claude`/`codex`) | zero-knowledge relay, E2E (TweetNaCl) | QR, keys generated on phone, no account | encrypted blobs on relay | yes, realtime (ElevenLabs agent SDK) | yes | yes (Expo app, Node server) |
| **Omnara** | user's machine (`omnara` wraps Claude Code) or Omnara cloud | Omnara backend | account login | Omnara backend | yes, two-way voice + STT | yes, one-tap approve | yes (Apache 2.0) |
| **Orca mobile** | user's Mac (Orca IDE) | Orca pairing | pair from desktop | mirror only | no | — | no |
| **DIY: Tailscale + tmux + SSH client** | user's machine | private VPN, raw terminal | Tailscale login | tmux scrollback | no (terminal clients cannot dictate) | no | n/a |

Two architectures dominate:

1. **Host-runs, relay-syncs** (Claude Code RC, Codex, Copilot, Happy, Omnara
   local mode). The agent process stays on the user's machine; a vendor relay
   holds a copy of the transcript (plaintext for Anthropic/GitHub, encrypted
   for Happy/Codex) so any signed-in device can render it and inject messages.
2. **Cloud-runs, everything on the server** (Cursor cloud agents, Codex cloud
   tasks, Omnara cloud). Mobile is just another client of a server-owned run.

Labee is (1) only: the agent runs on the user's Mac and labee.online is
the relay. Shape (2) is deliberately out of scope. The design doc's Device
Link is (1) without end-to-end encryption, which is the same trust level as
Claude Code RC and Copilot, both of which store plaintext transcripts
server-side.

---

## 2. Product notes

### 2.1 Claude Code Remote Control (Anthropic)

Docs: <https://code.claude.com/docs/en/remote-control>

**Model.** The local `claude` process becomes a server for its session.
Three entry points: `claude remote-control` (server mode, headless, can serve
several sessions), `claude --rc` (interactive terminal that is also remote),
and `/rc` inside a running session. The session URL opens on claude.ai/code;
spacebar shows a QR that opens the Claude iOS/Android app. Sessions appear in
the app's **Code** tab with a computer icon and a green dot when online.

**What the phone gets.** Full local environment (filesystem, MCP servers,
project config), `@` path autocomplete served by the host, image and file
attachments (photos go to the model; other files are downloaded to the host
and passed as `@` references), a diff pane computed on the host from
uncommitted changes, model and effort switching that changes what the host
runs, subagent and workflow progress, and permission prompts and
`AskUserQuestion` dialogs that stay open until answered. Messages sent
mid-turn are queued and appear after the turn.

**Resilience.** If the laptop sleeps or the network drops, the host reconnects
and, while rebuilding, queues messages, permission prompts, and status
updates. Interactive sessions retry indefinitely; server mode gives up after
~10 minutes. Crashed sessions in server mode are re-served when a device
sends a message. The terminal must stay running; closing it takes the session
offline until `claude remote-control --continue` / `--session-id` brings it
back. One remote session per interactive process; server mode multiplexes.

**Notifications.** Two toggles only: *push when Claude decides* (long task
finished, needs a decision; the user can also ask "notify me when tests
finish") and *push when actions required* (permissions, questions). Pushes are
suppressed while the user is typing in the connected terminal, or while a
`CLAUDE_CLIENT_PRESENCE_FILE` marker exists. Host shows "Still working —
check in from your phone" after a long turn, and "Approve tool calls from
your phone" after several permission prompts.

**Security.** Everything transits the Anthropic API over TLS with short-lived
single-purpose credentials. The transcript (messages, responses, tool
activity) is stored on Anthropic servers while connected; execution stays
local. Requires a claude.ai subscription login, not API keys. Enterprise
**Trusted Devices**: each device enrolls right after a full sign-in, and a
sign-in older than 18 h needs a Face ID / Touch ID / passkey step-up.

**Limits worth copying.** Forwarded dialogs other than permissions and
questions expire after 5 minutes; some slash commands are local-only;
compaction and `/clear` are mirrored to devices; switching conversations on
the host does not ship the new history to the phone.

### 2.2 Codex mobile (OpenAI, inside the ChatGPT app)

Docs: <https://learn.chatgpt.com/docs/remote-connections>; launch:
<https://openai.com/index/work-with-codex-from-anywhere/>; architecture
write-up *(secondary)*:
<https://codex.danielvaughan.com/2026/05/15/codex-mobile-chatgpt-app-relay-architecture-remote-agent-control/>

**Model.** The Mac runs the Codex app as the host. Phone pairs by scanning a
QR from *Settings › Connections › Control this Mac*, confirming the account
or workspace, and passing MFA/SSO. The host must be awake, online, and signed
in to the same account; a "Keep this Mac awake" toggle exists for that reason.
Multiple hosts show in a picker; SSH hosts from `~/.ssh/config` are reachable
*through* the Mac (phone → relay → Mac → SSH → devbox).

**What the phone gets.** Start or continue threads in the host's projects,
follow terminal output, screenshots, diffs and test results, approve commands
(same gates as desktop), switch model and reasoning effort mid-thread, add
context. Not supported: direct file editing, ad-hoc shell commands, plugin or
MCP configuration.

**Security.** OpenAI describes "a secure relay layer" that never exposes the
machine to the public internet. The secondary write-up describes X25519
ephemeral keys, Ed25519 host identity embedded in the QR, HKDF-derived
AES-256-GCM directional keys and monotonic counters, with the relay seeing
only metadata. Devices are listed and revocable in Settings › Connections.

### 2.3 GitHub Copilot remote control

Blog: <https://github.blog/news-insights/product-news/take-your-local-github-sessions-anywhere/>;
changelog: <https://github.blog/changelog/2026-04-08-github-mobile-research-and-code-with-copilot-cloud-agent-anywhere/>

`/remote on` in the Copilot CLI or VS Code publishes the session to
github.com and GitHub Mobile; a QR code opens it on the phone. The phone sees
plans, files read, edits and commands live, can send follow-ups mid-turn,
approve or deny permission requests, and take the work through to a pull
request and merge. Work stays on the originating machine; sessions are private
to the user. Generally available since 2026-05-18.

### 2.4 Cursor cloud agents on web and mobile

Docs: <https://cursor.com/docs/cloud-agent/web-and-mobile>; blog:
<https://cursor.com/blog/agent-web>

Cloud-first: agents run on Cursor machines, Team Pools, or the user's own
machine via Remote Control. The web app is installable as a PWA; there is also
a native iOS app (iOS 16+) with an iPad layout that keeps chats in a sidebar
while diffs take full width. Mobile can watch the live chat stream, send
follow-ups to a running agent, open subagent transcripts, read full diffs,
commits, checks and deployments, and merge PRs. **Push on turn completion and
Live Activities on the lock screen and Dynamic Island for up to eight agents
at once.** Slack integration for completion notices and `@Cursor` triggers.

### 2.5 Happy (open source)

Repo: <https://github.com/slopus/happy>; site: <https://happy.engineering>;
launch thread: <https://news.ycombinator.com/item?id=44904039>

**Model.** `happy` replaces `claude` / `happy codex` replaces `codex`. The
CLI wraps the agent, streams its state to a relay, and the Expo app (iOS,
Android, web) renders it. Switching back to the terminal is a keypress.
Monorepo: `happy-cli`, `happy-app` (Expo), `happy-server`, `happy-agent`
(remote session management), plus a native macOS app.

**Security.** No accounts. Keys are generated on the phone and paired with
the terminal by QR; the relay stores only encrypted blobs ("we protect our
infra, not your data, because we literally can't see it"). Uses TweetNaCl
(the same primitives as Signal). Self-hostable server.

**Voice.** Realtime voice is an ElevenLabs conversational-agent integration,
chosen because it can be configured to store neither audio nor transcripts.
The voice agent sits between the user and Claude Code, holding conversational
context and forwarding instructions, rather than piping raw STT into the
prompt.

**Notifications.** Push when the agent needs permission, hits an error, or
finishes a long task.

### 2.6 Omnara (open source)

App Store: <https://apps.apple.com/us/app/omnara-claude-codex-mobile/id6748426727>;
repo: <https://github.com/omnara-ai/omnara>; launch:
<https://www.ycombinator.com/launches/OCT-omnara-the-first-command-center-for-ai-agents-terminal-web-and-mobile>

**Model.** `pip install omnara && omnara` wraps Claude Code. The wrapper
mirrors the native terminal experience by **parsing the session file under
`~/.claude/projects` and the terminal output in real time**, forwarding
messages, permissions, and mode switches to the backend. Also runs agents in
Omnara's own cloud with atomic state in Postgres and pluggable sandboxes
(Modal, Daytona, Blaxel). Slack connector and REST API can launch agents.

**What the phone gets.** Monitor progress, review diffs, one-tap approve,
**two-way voice** ("brainstorm while commuting"), speech-to-text in the
composer, **live preview of the dev server on the phone without SSH or VPN**,
session pinning, Apple Watch app, multiple machines. Free app; Apache 2.0
server, self-hostable with Docker Compose.

### 2.7 Terminal mirrors and DIY

- **Orca mobile** (<https://www.onorca.dev/>): a thin live mirror of the
  desktop terminal with full keyboard input, phone-fit zoom and Ctrl/Alt
  accessory keys. Nothing runs on the phone. Reported as occasionally buggy.
- **Tailscale + tmux + Termius/Blink/mosh** (many write-ups, e.g.
  <https://kareemf.com/on-agentic-coding-from-anywhere>): zero vendor, zero
  cost, full fidelity, but no notifications, no voice, painful scrollback,
  and the agent's UI is a terminal on a 6-inch screen. VibeTunnel is a
  browser-based terminal that fixes scrollback and lets the phone keyboard
  dictate.

### 2.8 Vendor voice modes (for the voice half of the design)

**Claude voice mode** (<https://support.claude.com/en/articles/11101966-use-voice-mode>).
Two modes: *hands-free* (default; listens continuously, responds to natural
pauses) and *push-to-talk* (hold a button; recommended in noise). Barge-in:
start speaking and Claude stops. Preset voices only, 18+ languages, model
switchable mid-conversation (Opus/Sonnet/Haiku; Fable excluded), tools and
connected apps usable while speaking, "not every result can be shown on
screen in voice mode". Counts against normal usage limits.

**ChatGPT voice / OpenAI Realtime API**
(<https://developers.openai.com/api/docs/guides/realtime-vad>). Persistent
WebSocket/WebRTC session streaming audio both ways. Turn detection is
server-side: **server VAD** (`threshold`, `silence_duration_ms`,
`prefix_padding_ms`) or **semantic VAD** (`eagerness` low/medium/high, uses
what was said to decide the user is done, fewer false interruptions).
`turn_detection: null` gives push-to-talk with manual commits. Function
calling works inside a voice session. GPT-Live is full-duplex: keeps
listening while speaking and backs off mid-sentence.

**Happy** uses an ElevenLabs conversational agent (see 2.5); **Omnara** ships
two-way voice plus composer STT.

---

## 3. Feature matrix

| Capability | Claude RC | Codex | Copilot | Cursor | Happy | Omnara | Labee design |
|---|---|---|---|---|---|---|---|
| Continue a running local session | ✓ | ✓ | ✓ | ✓ (Remote Control) | ✓ | ✓ | ✓ (§4 sessions + §5 link) |
| Start a new session on the host from the phone | server mode | ✓ | – | ✓ | ✓ | ✓ | ✓ (long-press New) |
| Send while a turn is running (queued) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 409 today → **adopt queueing** |
| Approve tool calls / permissions | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | questions + gates only (no per-tool permissions in Labee) |
| Answer model questions (AskUserQuestion) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Diff of host working tree | ✓ (computed on host) | ✓ | ✓ | ✓ | ✓ | ✓ | read-only artifacts only → **add diff** |
| Attach photo / file from phone | ✓ | ✓ | – | ✓ | ✓ | – | not planned → **add photo** |
| Switch model / effort from phone | ✓ | ✓ | – | ✓ | – | – | not planned → **add** |
| Subagent / stage progress | ✓ | – | ✓ | ✓ (subagent cards) | – | ✓ | ✓ (research stages) |
| Reconnect with queued events after sleep | ✓ | host must be awake | ✓ | n/a | ✓ | ✓ | ✓ (`?after=seq`) |
| Push: needs decision | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Push: long task done / "Claude decides" | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ turn_ended; **add model-requested pushes** |
| Suppress push while at the desk | ✓ (presence file) | – | – | – | – | – | **adopt** (desktop window focused) |
| Live Activities / Dynamic Island | – | – | – | ✓ (8 agents) | – | – | ✓ |
| Apple Watch | – | – | – | – | – | ✓ | – |
| Two-way voice with the agent | via Claude app (text sessions) | – | – | – | ✓ realtime | ✓ | ✓ v1 STT+TTS, v2 streaming |
| Live dev-server preview on phone | – | screenshots | – | – | – | ✓ | – |
| Device list + revoke | Trusted Devices (Enterprise) | ✓ | – | – | keys on device | – | ✓ |
| E2E encryption (relay blind) | – (plaintext on Anthropic) | ✓ *(secondary)* | – | – | ✓ | – | – (v1) |
| Keep host awake toggle | – | ✓ | – | – | – | – | **adopt** (`powerSaveBlocker` in Electron) |
| Self-host / open source | – | – | – | – | ✓ | ✓ | n/a |

---

## 4. Implementation patterns that recur

1. **The host owns execution; a server owns the transcript.** Every product
   that supports attach-from-anywhere stores the event stream somewhere the
   phone can read without the host (Anthropic servers, GitHub, encrypted
   blobs on Happy's relay, Postgres for Omnara). Nobody streams straight from
   the laptop to the phone. This validates §4 of the design (server-owned
   sessions) as the prerequisite, and suggests the box should keep a mirror of
   desktop session events rather than tunnelling every read (§5.2). A mirror
   also makes hosted-offline reads possible ("Mac asleep, but here is the
   transcript").
2. **Queue, don't reject, messages sent mid-turn.** Claude RC, Codex and
   Copilot all accept a prompt during a running turn and deliver it after.
   The design's `409` should become a per-session queue with a "queued"
   badge.
3. **Pairing is QR + same account, with a device list.** Codex and Happy put
   a public key in the QR so the phone can verify the host; Claude RC relies
   on the account plus Trusted Devices enrolment. The design's approve-on-Mac
   6-digit code is in line with this; embedding the host key in a QR shown by
   the desktop is a cheap upgrade path to E2E later.
4. **Push policy is two switches, not a matrix.** "When the model decides"
   and "when action is required", plus presence suppression when the user is
   at the desk. Model-requested pushes ("notify me when tests finish") fall
   out naturally if the agent has a `notify` tool.
5. **The diff is computed on the host on demand**, not streamed. One request,
   one response, rendered with syntax highlighting on the phone.
6. **Voice sits beside the transcript, not inside it.** Claude and ChatGPT
   voice modes reuse the same conversation; Happy inserts a voice agent that
   holds its own context and forwards instructions. Both keep a visible
   transcript and let the user switch to text mid-conversation. Hands-free
   with barge-in is the default everywhere; push-to-talk is the noisy-room
   fallback. Semantic end-of-turn detection is what makes hands-free feel
   good; silence-only VAD interrupts people mid-thought.
7. **Live Activities are the mobile "still working" indicator.** Cursor
   tracks up to eight agents; ActivityKit caps an activity at 8 hours and
   4 KB per push, so the payload is stage + elapsed + cost, not output.
8. **Dialogs expire.** Permission and question prompts wait forever; other
   forwarded dialogs auto-dismiss after minutes so a host is never wedged on
   a phone that went into a pocket.

---

## 5. Changes to make to the Labee design

Concrete deltas to [mobile-companion-design.md](./mobile-companion-design.md)
based on the survey:

- **§4.2 / §4.3** Replace `409` on a second `startTurn` with a per-session
  message queue; add `turn_queued` / `turn_dequeued` events and a queued
  badge in the composer.
- **§4.3** Add `GET /api/sessions/:id/diff` (host computes `git diff` of the
  cwd, or last commit when clean) and photo attachments on `POST …/turns`
  (image → model, other files → cwd + `@` reference), mirroring Claude RC.
- **§4.3** Add `model` and `effort` overrides on the turn request so the phone
  can switch models mid-session, as Claude RC and Codex allow.
- **§5.4** Have the box **mirror** desktop session events (write-through from
  the Device Link) so the phone reads the transcript from the box and only
  turn/cancel/answer/diff requests are tunnelled. Cheaper on the relay,
  readable while the Mac sleeps, and identical to how Anthropic and GitHub do
  it. (Applied to the design doc.)
- **§5.3** Show a QR on the desktop (Settings › Devices) carrying a host
  public key next to the 6-digit code, so a future E2E mode (Happy/Codex
  style) needs no re-pairing.
- **§6** Add a **Keep Mac awake while devices are attached** toggle
  (Electron `powerSaveBlocker`), since a sleeping host is the top failure
  mode reported for Codex mobile.
- **§7.1** Make hands-free the default with semantic end-of-turn detection
  (v2 via Realtime semantic VAD, `eagerness: low`); push-to-talk stays as the
  noisy-environment mode, matching Claude's voice mode.
- **§8** Adopt the two-switch push policy plus presence suppression when the
  desktop window is focused, and give the agent a `notify_me` tool so
  "notify me when the run finishes" works as a prompt.
- **§8** Cap Live Activities at one per session and eight per user, with an
  explicit "open the app" end state before the 8-hour limit.
- **§10** Note that plaintext transcripts on the box match Anthropic and
  GitHub's trust model; E2E is a differentiator only against Happy and Codex.

---

## 6. Sources

- Claude Code Remote Control docs — <https://code.claude.com/docs/en/remote-control>
- TechRadar on Remote Control — <https://www.techradar.com/pro/anthropic-reveals-remote-control-a-mobile-version-of-claude-code-to-keep-you-productive-on-the-move>
- Codex remote connections (OpenAI) — <https://learn.chatgpt.com/docs/remote-connections>
- "Work with Codex from anywhere" (OpenAI) — <https://openai.com/index/work-with-codex-from-anywhere/>
- Codex mobile relay architecture *(secondary)* — <https://codex.danielvaughan.com/2026/05/15/codex-mobile-chatgpt-app-relay-architecture-remote-agent-control/>
- TechCrunch, Codex on phones — <https://techcrunch.com/2026/05/14/openai-says-codex-is-coming-to-your-phone/>
- GitHub: take your local sessions anywhere — <https://github.blog/news-insights/product-news/take-your-local-github-sessions-anywhere/>
- GitHub Mobile + Copilot cloud agent changelog — <https://github.blog/changelog/2026-04-08-github-mobile-research-and-code-with-copilot-cloud-agent-anywhere/>
- Cursor cloud agents on web and mobile — <https://cursor.com/docs/cloud-agent/web-and-mobile>, <https://cursor.com/blog/agent-web>
- Happy repo and launch — <https://github.com/slopus/happy>, <https://happy.engineering/>, <https://news.ycombinator.com/item?id=44904039>
- Happy architecture write-up *(secondary)* — <https://www.blog.brightcoding.dev/2026/02/19/happy-coder-the-secure-mobile-cli-revolution>
- Omnara — <https://apps.apple.com/us/app/omnara-claude-codex-mobile/id6748426727>, <https://github.com/omnara-ai/omnara>, <https://www.ycombinator.com/launches/OCT-omnara-the-first-command-center-for-ai-agents-terminal-web-and-mobile>
- Orca — <https://www.onorca.dev/>, <https://antran.app/blogs/2026/orca_agent_ide_kai/>
- DIY terminal workflows — <https://kareemf.com/on-agentic-coding-from-anywhere>, <https://dev.to/stevengonsalvez/remote-coding-running-ai-agents-from-anywhere-the-full-stack-4lji>
- Claude voice mode — <https://support.claude.com/en/articles/11101966-use-voice-mode>, <https://www.macrumors.com/2026/07/24/claude-voice-mode-opus-sonnet-model-support/>
- OpenAI Realtime API and VAD — <https://openai.com/index/introducing-the-realtime-api/>, <https://developers.openai.com/api/docs/guides/realtime-vad>
- iOS Live Activities — <https://developer.apple.com/videos/play/wwdc2026/223/>, <https://vp0.com/blogs/ios-dynamic-island-live-activities-ai-agent>
