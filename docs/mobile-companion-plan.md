# Labee Mobile — implementation plan and test plan

Executes the design in [mobile-companion-design.md](./mobile-companion-design.md)
(as amended by the [survey](./mobile-companion-survey.md)). Written 2026-09-19
for an unattended overnight build; every step has a check that runs without a
human, an Apple developer account, or Xcode (this machine has command-line
tools only, so the iOS simulator is unavailable). The app is verified on the
Expo **web** target in Chrome plus unit tests; native-only pieces (APNs, Live
Activities) are wired but exercised by unit tests only.

## Scope of this build

| # | Deliverable | Where |
|---|---|---|
| 1 | Server-owned chat sessions: tables, runner, queueing, cancel, answer, diff, SSE replay+tail | `apps/server/src/services/sessions/*`, `routes/sessions.ts` |
| 2 | `/api/chat` refactored onto a shared turn builder (no behaviour change) | `apps/server/src/services/turnBuilder.ts` |
| 3 | Web client attaches to server sessions (send → turn, events stream, re-attach on load) | `apps/web/src/store/chat-store.ts` |
| 4 | `packages/session-core`: framework-free event reducer shared by web and mobile | new package |
| 5 | Device Link: desktop dials the box, box tunnels phone requests, mirrors events, device approval, Expo push relay | `apps/server/src/services/deviceLink/*`, `routes/link.ts` |
| 6 | Expo app: sign-in, hosts, sessions, session (transcript, composer, push-to-talk, read-aloud, stop), inbox, runs, devices | `apps/mobile` |
| 7 | Fake `claude` binary for deterministic tests | `apps/server/test/fixtures/fake-claude.mjs` |

Out of scope tonight: hands-free VAD, Live Activities, streaming STT,
server TTS, LAN direct, `--resume`.

## Code-writing plan

### Step 1 — Server-owned sessions

1.1 `services/db.ts`: add `chat_sessions`, `chat_session_events`,
`chat_session_messages`, `link_devices`, `mirror_sessions`, `mirror_events`
(`CREATE TABLE IF NOT EXISTS`, same style as research tables).

1.2 `services/sessions/db.ts`: CRUD + `appendEvent` (returns seq),
`listEventsAfter`, `compactTurn` (drop `thinking_delta`/`delta` rows for a
finished turn), `enqueueTurn` / `dequeueTurn`.

1.3 `services/turnBuilder.ts`: `prepareTurn(email, body)` extracted from
`routes/chat.ts`, returning `{ ok: true, makeStream, cwd, linkedSkillNames }`
or `{ ok: false, message }`. `makeStream` returns the existing SSE byte
stream for all three engines, so a single SSE parser feeds the runner.

1.4 `services/sessions/runner.ts`: registry of live sessions
(`{ child, listeners, queue }`), `startTurn` (persists `turn_started` +
user message, spawns, parses SSE bytes to events, appends each with seq,
publishes), `cancelTurn`, `answerQuestion` (answer → next user message),
`subscribe`, `getHandle`. Client disconnects never touch the child. On
`end`/`error`/`result`: persist assistant message, `turn_ended`, compact,
then dequeue the next queued turn.

1.5 `routes/sessions.ts`: the API in design §4.3 plus `GET …/diff` and
`POST …/turns` accepting `model`, `effort`, `voice`. `GET …/events` copies
`runEventsRoute` (replay-before-tail, `Last-Event-ID`, heartbeat,
`?coalesce=ms`).

1.6 `routes/chat.ts` calls `prepareTurn`; response shape unchanged.

### Step 2 — session-core

2.1 `packages/session-core/src/reducer.ts`: `reduce(state, event)` over the
SSE vocabulary → `{ messages, activity, streaming, question, stats }`.
2.2 `sse.ts`: byte/line parser shared by server runner, web, and mobile.

### Step 3 — Web client attach

3.1 `chat-store.ts`: `SessionMeta.serverId`; `send()` creates the server
session on first use, POSTs a turn, then consumes
`GET /api/sessions/:id/events?after=` with the existing `handleSSE`. On
store init, sessions with `serverId` whose status is `running` re-attach.
Cancel → `POST …/cancel`. Question answers → `POST …/answer`.
3.2 `/api/chat` stays for edit mode.

### Step 4 — Device Link

4.1 Box: `routes/link.ts` — `GET /api/link/host` (WebSocket upgrade;
cookie auth; registers `{ email, hostId, name }`), `ANY /api/hosts/:hostId/*`
(tunnel with streaming response; 503 when offline), `POST /api/link/devices`
(phone asks to pair → forwarded to host), `GET /api/link/devices`,
`DELETE /api/link/devices/:id`, `POST /api/link/push-token`,
`GET /api/link/hosts`. Mirror: `mirror` frames upsert `mirror_sessions` /
`mirror_events`; `GET /api/hosts/:hostId/mirror/sessions[/:id[/events]]`
serve reads from the mirror.
4.2 Desktop: `services/deviceLink/client.ts` — when `LABEE_MODE=desktop`
and the box session file exists, dial the box (global `WebSocket`, Node 24),
heartbeat, reconnect with backoff, serve tunneled requests by fetching
`http://127.0.0.1:<port>` with an internal link header, push `mirror`
frames from the runner, answer `device_request` with pending approvals
(`GET /api/link/pending`, `POST /api/link/pending/:id/approve|reject`).
4.3 `httpKit.sessionUser` honours `x-labee-link-user` when
`x-labee-link-secret` matches the process secret (desktop only).
4.4 Push: `services/push.ts` posts to the Expo push API for
`question_asked`, `turn_ended` (only if no device is streaming), `error`.

### Step 5 — Expo app

5.1 `apps/mobile` via `create-expo-app` (Expo SDK 57, Expo Router,
TypeScript). Deps: `react-native-sse`, `expo-audio`, `expo-speech`,
`expo-notifications`, `expo-secure-store`, `@labee/contracts`,
`@labee/session-core`.
5.2 `src/api`: base-URL config (box URL, or direct host URL for dev),
cookie auth, `sse.ts` (EventSource on web, `react-native-sse` on native).
5.3 Screens: `sign-in`, `hosts`, `sessions`, `session/[id]`, `inbox`,
`runs`, `runs/[id]`, `settings/devices`.
5.4 Voice: `usePushToTalk` (expo-audio → base64 → `/api/transcribe`),
`useReadAloud` (sentence splitter over `delta` events → `expo-speech`),
voice commands (`stop`, `approve`, `reject`) before send.
5.5 iPad: two-pane layout when width ≥ 768.

## Test plan

| Layer | Test | How it runs |
|---|---|---|
| Fixture | `fake-claude.mjs` emits a scripted `stream-json` transcript (init, thinking, text deltas, a tool call, result); `FAKE_CLAUDE_SCRIPT=question` emits an AskUserQuestion; `=slow` sleeps between deltas; `=fail` exits 1 | `CLAUDE_BIN` env |
| Unit | session-core reducer: deltas accumulate, tool blocks open/close, question detection, result stats, error | `bun test`/vitest in package |
| Unit | sessions db: append seq monotonic per session, listEventsAfter, compaction removes deltas but keeps messages | vitest, temp `LABEE_DATA_DIR` |
| Unit | runner: turn persists events; second turn while running is queued and runs after; cancel kills child and emits `turn_cancelled`; question sets `awaiting_input` and `answer` starts a new turn; client subscribe/unsubscribe never kills the child | vitest + fake claude |
| Integration | HTTP: boot server on a random port (Bun), create user + sealed cookie, `POST /sessions`, `POST turns`, `GET events?after=0` replays then tails, `Last-Event-ID` resume, `GET diff` in a temp git repo, 503 on unknown session | vitest, spawns `bun run src/bin.ts` |
| Integration | Device Link: box server + desktop server in one test; desktop dials box; `GET /api/hosts/:id/api/sessions` tunnels; SSE through the tunnel; mirror rows appear on box; host offline → 503; device pairing request → pending on desktop → approve → token works | vitest |
| Web | `apps/web` typecheck + existing vitest; manual-free smoke: store creates server session and re-attaches (vitest with mocked fetch) | vitest |
| Mobile | jest-expo: reducer hook, sentence splitter for read-aloud, voice command parser, API client URL building | `bun run test` in apps/mobile |
| Mobile | `tsc --noEmit`; `expo export --platform web` bundles | CI-style |
| E2E | Expo web build served locally, pointed at a local desktop server with fake claude; Chrome DevTools MCP: sign in, open session, send a message, see streamed reply, send while running → queued badge, stop, answer a question card | scripted at the end of the build |
| Repo | `bun run typecheck`, `bun run lint`, `bun run test` all green | final gate |

## Execution log

Filled in as steps complete (see the end of this file).

### 2026-09-19 overnight build

| Step | Result |
|---|---|
| 1 Server-owned sessions | Done. `chat_sessions`, `chat_session_events`, `chat_session_messages`, `chat_session_queue` tables; `services/sessions/{db,runner}.ts`; `routes/sessions.ts` (create/list/get/patch/delete, turns with queueing, cancel, answer, queue removal, diff, replay-then-tail SSE with `Last-Event-ID`, `?coalesce`, `?once`). Boot recovery marks crashed turns. |
| 2 Turn builder | Done. `services/turnBuilder.ts` (`prepareTurn`) extracted from `routes/chat.ts`; `/api/chat` unchanged in behaviour; `voice` and `effort` request fields added. |
| 3 Web client attach | Done. `chat-store.ts` creates a server session on first send, posts turns, tails `/events` for the open session, renders turns started from other devices (device chips), cancels on the server, re-attaches on load. Edit mode still uses `/api/chat`. |
| 4 session-core | Done. `packages/session-core`: SSE parser, replay-idempotent transcript reducer, sentence chunker, voice command grammar. 14 unit tests. |
| 5 Device Link | Done. Box: `routes/link.ts` (host WebSocket with heartbeat, tunnel `/api/hosts/:hostId/*` with streaming, mirror reads when offline, devices, pending approvals, push tokens, Expo push relay). Desktop: `services/deviceLink/client.ts` (dials the box with a short-lived link token, replays requests on loopback with the per-process link secret, mirrors events/summaries/messages). `httpKit.sessionUser` accepts device bearer tokens and tunneled link headers. Web Settings › Devices panel. |
| 6 Expo app | Done. `apps/mobile` (Expo SDK 57, Expo Router). Screens: sign-in, Sessions, Runs, Inbox, Settings, Hosts, Devices, Session (transcript, activity strip, question card, composer with hold-to-talk, read-aloud, voice overlay, iPad side pane with Activity/Diff), Run (timeline, gate card, paper, claims). Push registration via Expo push tokens. |
| 7 Fake claude | Done. `apps/server/test/fixtures/fake-claude.mjs`; behaviour by `FAKE_CLAUDE_SCRIPT` or a `[[question|slow|fail|echo]]` marker in the prompt (last marker wins). |

Test results (all green at the end of the run):

| Suite | Count |
|---|---|
| `apps/server` vitest (runner, HTTP, Device Link, plus existing) | 57 |
| `packages/session-core` vitest | 14 |
| `apps/mobile` vitest | 2 |
| `bun run typecheck` | 7/7 workspaces |
| `bun run lint` | no new warnings (pre-existing ones in `.claude/worktrees` and `scripts/users.mjs`) |
| `expo export --platform web` | bundles |

Browser end-to-end (Expo web build served by the server via `LABEE_STATIC_DIR`, fake claude, Chrome): sign-in → new session → streamed reply with tool strip and cost → turn started from another device appears live with a "Mac" chip → second turn queues with a banner and runs after → Stop button shown while running → AskUserQuestion card → answer becomes the next user message and a new turn runs → reload mid-turn recovers without duplicates → direct load of `/inbox` stays signed in. Bugs found and fixed during the run: first-marker vs last-marker in the fixture, transcript duplication on reload (reducer now idempotent over seeded turns), auth gate racing the first `/api/me`, header status not updating after a turn.

Native paths, verified without hardware:

| Path | How it was exercised | Result |
|---|---|---|
| Push notifications | `apps/server/test/push.test.ts`: box + desktop, paired device with an Expo push token, `EXPO_PUSH_URL` pointed at a fake endpoint | question → push with the session title and `kind: question`; unwatched finished turn → push with the reply text |
| Microphone → transcribe | Web build in Chrome with `getUserMedia` replaced by an oscillator stream; hold-to-talk on the composer mic | placeholder shows "Listening…", a 15 KB `audio/webm` clip was posted to `/api/transcribe`, composer returns to idle; the error the server returns (no STT key on the fake server) is now shown under the composer |
| Read-aloud (TTS) | Web build with `speechSynthesis.speak` recorded | reply spoken as "Hello from fake claude." then "The README is short.", both via the API-started turn and the composer path |

Still not run on this machine: an actual iOS build. This Mac has command-line
tools only (no Xcode, so no simulator), and a native build through EAS needs
an Expo account login plus Apple credentials that require a 2FA step. The Apple
developer account is signed in in Chrome (team `W3X4ZUG72V`, recorded in
`apps/mobile/app.json` and `eas.json`); it has **no App ID registered yet**.
Apple account setup done on 2026-09-19 (team `W3X4ZUG72V`):

| Item | Value |
|---|---|
| App ID | **Labee**, explicit bundle ID `online.labee.mobile`, Push Notifications enabled |
| APNs key | **Labee Push**, Key ID `6Z9AWRQZAX`, Sandbox & Production, team scoped |
| Key files | `~/.labee/apple/AuthKey_6Z9AWRQZAX.p8` (APNs) and `~/.labee/apple/AuthKey_YHLN5F2K6D.p8` (App Store Connect API, Admin, Key ID `YHLN5F2K6D`, Issuer `2ca40275-6b74-4791-8e56-83728d7f6f42`). One-time downloads, mode 600; back them up. |
| EAS project | `@menbinwan/labee-mobile`, id `5867c3e7-6f90-4d9e-9aad-711bc7e48e85` (https://expo.dev/accounts/menbinwan/projects/labee-mobile) |
| Google sign-in (mobile) | `GET /api/auth/google?mobile=labee://auth` bounces the sealed session to the app's custom scheme; the app sends it back in the `x-labee-session` header (`httpKit.sessionData` accepts it). Google-only accounts have no password, so this is the only way such users can sign in on the phone. Build 2: https://expo.dev/accounts/menbinwan/projects/labee-mobile/builds/9575cdf6-2fc1-4e6a-8bf3-fbe842ee322d |
| TestFlight | Build 1 processed and **Ready to Submit** (export compliance answered: no non-exempt encryption); attached to internal group "Team (Expo)" with menbinwan@gmail.com invited. Build 1 (0.1.0) submitted 2026-09-20 via `eas submit` with the ASC API key: https://expo.dev/accounts/menbinwan/projects/labee-mobile/submissions/043aa281-ad60-46fd-9376-e6f6fe97e153 → https://appstoreconnect.apple.com/apps/6814107220/testflight/ios (Apple app id `6814107220`, set as `ascAppId` in `eas.json`). Add yourself as an internal tester there and install via the TestFlight app. `ITSAppUsesNonExemptEncryption=false` is now set for future builds; this first build may show an export-compliance question in App Store Connect (answer No, standard encryption only). |
| EAS service credentials | Push key `6Z9AWRQZAX` and ASC API key `YHLN5F2K6D` uploaded on expo.dev (project credentials → online.labee.mobile), so `eas build` / `eas submit` need no Apple login and no env vars. |
| EAS iOS credentials | Distribution certificate (serial `2ACD3FF68A3E877DB86D1AD5545513D9`, expires 2027-09-20) and App Store provisioning profile `HAXNR5UQT9`, created by EAS with the ASC API key. First production build: https://expo.dev/accounts/menbinwan/projects/labee-mobile/builds/231bbd41-9a90-463d-89a1-c4d23155b5bc |
| App Store Connect | app record **Labee** (iOS, bundle `online.labee.mobile`, SKU `labee-mobile`, en-US), status Prepare for Submission — created 2026-09-20 |

Upload the key to EAS once: `bunx eas-cli credentials` → iOS → Push Notifications → provide the `.p8`, Key ID `6Z9AWRQZAX`, Team ID `W3X4ZUG72V`.

### 2026-09-20 native run (Xcode 27, iPhone 17 simulator, iOS 27)

Built with `bunx expo run:ios --device "iPhone 17"` after installing Xcode and
CocoaPods (`brew install cocoapods`). Driven with `idb` (`brew install
idb-companion`, `pip3 install fb-idb`) for taps/typing and `xcrun simctl io
booted screenshot` for screens.

| Check | Result |
|---|---|
| App launch | First build trapped at launch (`UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`); fixed by the scene-lifecycle plugin below. Launches cleanly after. |
| Sign in to a local desktop server | OK (`http://127.0.0.1:3999`; the iOS "Save Password?" sheet appears afterwards) |
| Sessions list | Shows the session created earlier from the web build |
| Open shared session, send a turn | Full history from web/Mac renders with device chips; the new turn is tagged `iPhone`; reply streams with tool strip and cost |
| Read-aloud on + turn | Runs without error (on-device TTS through the simulator's audio) |
| Voice overlay | Opens with the spoken caption; close works |
| Microphone | The iOS permission prompt shows the app's usage string; granting also needs the **macOS** prompt "SimulatorTrampoline.xpc would like to access the Microphone" (click Allow on the Mac). After that the simulator's mic bridge is unusable for testing: `prepareToRecordAsync` takes 5–15 s and `record()` blocks the JS thread for tens of seconds, so clips end up empty. The app now bounds each step with a timeout and shows the error under the composer. The same JS pipeline (record → base64 → `/api/transcribe`) was verified on the web build; verify native capture on a physical device. |
| Push | Not testable on a simulator (`Device.isDevice` is false, no APNs); covered by `push.test.ts` |

App icon: source is `apps/mobile/assets/icon.svg` (a bee at the bench
pipetting into a flask). Regenerate the PNG Apple needs (1024×1024, opaque)
with:

```sh
cd apps/mobile
qlmanage -t -s 1024 -o /tmp assets/icon.svg          # → /tmp/icon.svg.png (has alpha)
# flatten onto the brand background (any tool; the build used a 20-line Swift CoreGraphics script)
bunx expo prebuild --platform ios --no-install         # regenerates the asset catalog
```

Voice overlay close bug (fixed 2026-09-21): the full-screen overlay wrapped
its content in a tap-to-interrupt `Pressable` that captured every touch, so the
X (a child Pressable) never received taps; the X also sat under the Dynamic
Island. Fix in `src/ui/VoiceOverlay.tsx`: plain View container with safe-area
insets, X in a visible circular button below the inset, an explicit Done
button, and a scoped "Stop speaking" control instead of the whole-screen
interrupt target. Added `app/auth.tsx` (route for `labee://auth?session=…`) so
the Google sign-in return and session-injection deep links land on a real
screen instead of "Unmatched Route".

Xcode 27 note: the iOS 27 SDK traps at launch unless the app adopts the
UIScene life cycle. `apps/mobile/plugins/withSceneLifecycle.js` (registered
in `app.json`) patches the generated `AppDelegate.swift` and `Info.plist` on
every prebuild; keep it until the Expo template adopts scenes itself.

Hosting note (2026-09-21): labee.online now resolves to the truegrit EC2 box
(3.144.175.137, key `~/.ssh/truegrit-default-key.pem`, user `ubuntu`); the old
Lightsail box with the original user database is unreachable. Labee is
deployed there as a fresh install with `scripts/deploy-truegrit.sh` (builds
locally, ships only artifacts to `/opt/labee`, systemd unit `labee` on :3010,
Caddy routes `labee.online/` to it and keeps `/mcp` on the Protocol-Searcher).
`LABEE_OPENAI_API_KEY` is set on the box (voice transcription works server-side;
users need no key). Still to add for the provided tier: Stripe keys and
`LABEE_ANTHROPIC_OAUTH_TOKEN`. The deploy script preserves extra variables in
`/etc/labee.env` across redeploys.

Runbook when someone is at the keyboard:

1. Install Xcode (App Store) and run `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.
2. `cd apps/mobile && bunx expo run:ios` — builds and launches the simulator; sign in to a local desktop server (`http://<mac-ip>:3000`) or labee.online.
3. For a device / TestFlight build: `bunx eas-cli login`, then `bunx eas-cli build --platform ios --profile preview`. EAS registers the App ID `online.labee.mobile` and provisioning with the Apple account (prompts for 2FA once), and `bunx eas-cli credentials` uploads an APNs key so Expo push tokens deliver.
4. Push end to end: pair the phone under Settings › Devices, approve it on the Mac's Settings › Devices, enable notifications, then ask the agent a question from the Mac and lock the phone.

How to run the end-to-end setup by hand:

```sh
# terminal 1 — server hosting the mobile web build with the fake CLI
cd apps/mobile && bunx expo export --platform web --output-dir dist
cd ../server
LABEE_DATA_DIR=/tmp/labee-e2e/data DECK_ROOT=/tmp/labee-e2e/decks SKILLS_ROOTS=/tmp/labee-e2e/skills \
CLAUDE_BIN=$PWD/test/fixtures/fake-claude.mjs SESSION_PASSWORD=$(openssl rand -hex 24) COOKIE_SECURE=false \
LABEE_STATIC_DIR=$PWD/../mobile/dist LABEE_PORT=3999 bun run src/bin.ts
# then open http://127.0.0.1:3999, sign up, and use "[[question]]" / "[[slow]]" in a message
```
