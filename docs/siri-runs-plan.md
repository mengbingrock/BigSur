# Siri + protocol runs — implementation plan, for review

Executes [siri-design.md](./siri-design.md) and
[protocol-run-design.md](./protocol-run-design.md). Written 2026-10-09.
Nothing below is built. The plan is ordered so each stage ships on its own,
is testable without the next, and the stages that need a physical iPhone
come after the ones that do not.

## 0. Decisions (taken 2026-10-09)

| # | Question | Decision |
|---|---|---|
| D1 | Where does a Siri message with no session named go? | **A dedicated "Siri" session** that acts as the router: it finds the right session to continue, or creates a new one (siri-design §3.3). |
| D2 | Is a run's chat created fresh, or may a run start inside an existing chat? | **Answered by D1**: the router resumes a paused run of the protocol, continues an existing chat with the protocol attached, else creates new (run-design §8). |
| D3 | The write-up is also posted as the run's last assistant message? | Yes. |
| D4 | Research runs stay in the Runs tab as a second group? | Yes. |
| D5 | Ask the run's scale at start when the protocol names a base quantity? | Yes, skippable with "default". |
| D6 | Minimum iOS for the Siri build. | iOS 26; older devices get the app without Siri phrases. |

## 1. Scope

| # | Deliverable | Where | Stage |
|---|---|---|---|
| 1 | Run records on the box: `protocol_runs`, `protocol_run_events`, API | `apps/server/src/services/runs/*`, `routes/runs.ts`, `services/db.ts` | 1 |
| 2 | Step parser (frozen snapshot, amounts, materials, timers, spoken form) | `apps/server/src/services/runs/parse.ts` | 1 |
| 3 | `run` frames on the Device Link; transcript system lines; agent run context | `services/deviceLink/protocol.ts`, `client.ts`, `routes/link.ts`, `services/sessions/*`, `turnBuilder.ts` | 1 |
| 4 | The Siri session and router (`/api/siri/route`), quick answers (`/api/ask/quick`), amount tiers (`/api/runs/:id/amount`), answer mapping for `AskUserQuestion` | `services/siri/router.ts`, `routes/siri.ts`, `routes/ask.ts`, `services/artifactIndex/ask.ts`, `services/sessions/answerMap.ts` | 1, 4 |
| 5 | Notifications: categories with actions, time-sensitive level, deep links | `apps/mobile/src/notifications.ts`, `services/push.ts`, `routes/link.ts` | 2 |
| 6 | App: Start run, run screen step bar, Runs tab groups, Note, timers | `apps/mobile/app/protocol/[slug].tsx`, `app/session/[id].tsx`, `app/(tabs)/runs.tsx`, `src/api/runs.ts`, `src/ui/StepBar.tsx` | 2 |
| 7 | Siri config bridge module | `apps/mobile/modules/labee-siri/` | 3 |
| 8 | Siri intents (inline modules), entities, phrases, shortcut link | `apps/mobile/app-intents/` | 3, 4 |
| 9 | Live Activity, Control Center control, Action button | `@bacons/expo-apple-targets` widget target | 5 |

Out of scope: a notebook, communication notifications (spoken replies to
announcements), Watch, `expo-app-intents` migration (waits for SDK 58),
two concurrent runs, protocol editing from the phone.

## 2. Stage 1 — Server: runs, parser, link, agent context (no UI)

Ships behind nothing; the web client can call it, and the tests cover it.

**1.1 Tables** (`services/db.ts`): `protocol_runs`, `protocol_run_events`
as in run-design §2, `CREATE TABLE IF NOT EXISTS` beside the research
tables. `deleteAccount` learns both tables (`services/account.ts`,
`test/account.delete.test.ts`).

**1.2 Parser** (`services/runs/parse.ts`): pure function
`parseProtocol(markdown) → { steps, materials, base?, hash }`.
- Steps: the numbered list under the first of `## Procedure`, `## Steps`,
  `## Method`; sub-bullets and a following `## Notes` paragraph attached
  by step number when it names one ("after step 4"). Fallback: one step per
  paragraph, flagged `loose: true`.
- Amounts: regex over a fixed unit list (`µL|ul|mL|ml|L|mg|g|µg|ug|ng|mM|M|%|rpm|×g|x g|°C|C|min|h|s`), capturing the noun phrase after "of" or
  before the unit; `ratio: true` for `%` and "x" multiples.
- Timer: first duration in the step.
- `say`: units expanded, ranges kept ("ten to fifteen minutes"), numbers
  left as digits for the TTS.
- `base`: a volume/mass in step 1–2 phrased as "into N ml of" or "N ml
  culture", if any (for D5).
Tests: the nine seeded protocols in `apps/server/seed/protocols/**` parse
to the expected step counts, timers and amounts (snapshot test); a
protocol with no list falls back and is flagged; editing text does not
change earlier steps' numbers.

**1.3 Run service** (`services/runs/db.ts`, `services/runs/service.ts`):
`startRun(email, { protocolSlug, sessionId?, scale? })` — on the box this
asks the host to parse (see 1.5), on a host it parses locally;
`advance`, `back`, `skip`, `note`, `startTimer`, `cancelTimer`, `pause`,
`resume`, `finish`, `abandon` — each appends an event, recomputes
`current`/`status`, publishes to subscribers. `amountFor(run, material,
step?)` implements tier 1 of run-design §4.2 and returns
`{ found, text, step, computed? }`.

**1.4 Routes** (`routes/runs.ts`): run-design §2.3. Box-answered: add the
`/api/runs` prefix to the box-only list the relay keeps for billing, and to
`BOX_ONLY` in `apps/web/src/lib/api.ts` and the mobile client's equivalent.

**1.5 Device Link** (`services/deviceLink/protocol.ts`):
- box → host `run { event }` for every run event of that host's account;
  `runs { since }` on connect for replay.
- host → box `parse { reqId, protocolSlug }` / `parsed { reqId, snapshot }`
  so `POST /api/runs` can freeze the steps from the host's copy of the
  protocol; 503 "Your Mac is asleep" when no host is connected.
- Host side (`client.ts`): on `run`, append a system line to the session
  transcript (`services/sessions/db.ts` gains `appendSystemMessage`), which
  flows through the existing mirror back up so the phone's transcript
  shows it too.
Tests: extend `test/deviceLink.test.ts` with a fake host that answers
`parse`; assert the system line appears in the mirrored messages.

**1.6 Agent context** (`services/turnBuilder.ts`): when the session has a
run, append the run view (current step, step log, notes, timers, elapsed,
scale) after the protocol addendum. `finish` starts one turn with the
write-up instruction (run-design §4.3), `voice: false`, and — per D3 —
the result is also the session's final assistant message.
Tests: `test/sessions.runner.test.ts` with the fake claude: the prompt
contains the run view; finishing produces `Runs/<date> <name>.md` in the
deck.

**1.7 The Siri session and router** (`services/siri/router.ts`,
`routes/siri.ts`): `ensureSiriSession(email)` (one per account,
`kind: "siri"`, excluded from "most recent" lookups and from archiving);
`route(email, { text, kind, protocolSlug?, sessionId? })` implementing the
six steps of siri-design §3.3 — named session, pending question, active
run, model over the last twenty sessions (`haiku`, 3 s budget, falls
through to "new" on timeout), low-confidence → candidates, else new. For
`kind: "start"`: a paused/running run of the protocol → resume; a session
with the protocol attached → continue; else new. Every call appends a
system line to the Siri session: what was heard, where it went. The Chats
list pins the Siri session at the top (`toSummary` gains `kind`).
Tests: a seeded set of sessions and runs; named / pending / active-run
routing without the model (assert no model call); the model path with the
fake claude returning a fixed choice; timeout → new; the log line.

**1.8 Quick answers and answer mapping**:
- `routes/ask.ts`: `POST /api/ask/quick { q, sessionId?, runId? }` →
  `askLibrary` with a spoken-answer instruction, `haiku`, 7 s budget,
  `needsAgent` on the model's say-so or timeout; with `runId`, the run
  view is added to the passages.
- `services/sessions/answerMap.ts`: `mapSpokenAnswer(question, text)` —
  option label (case/punctuation-insensitive), ordinal words and numbers,
  yes/no for two options, else `{ other: text }`. Used by
  `POST /api/sessions/:id/answer` when the body has `spoken: true`.
Tests: unit tests for the mapper (ordinals, "the second one", labels with
punctuation, free text); the quick route against the fake embedder.

Exit: `bunx vitest run` green; from the web app's console, a run can be
started, advanced and finished against the dev server, the chat shows the
system lines and the write-up, and a routed message shows up in the Siri
session's log and in its destination.

## 3. Stage 2 — App: runs without Siri

**2.1 API client** (`src/api/runs.ts`): the routes in 1.4 plus
`amountFor`.

**2.2 Protocol screen**: **Start run** beside "Ask about this"; a sheet
previews the parsed steps ("9 steps · 2 timers"), asks the scale when
`base` is present (D5), then creates the run and opens the session.

**2.3 Run screen** (`app/session/[id].tsx` + `src/ui/StepBar.tsx`): the
step bar from run-design §5.2 — current step text, amounts line, timer,
Done; tap for the checklist; swipe for Back/Skip; **Note** button = the
existing hold-to-talk filed through `POST …/note`. Transcript below as
today; system lines rendered as quiet rows.

**2.4 Runs tab** (`app/(tabs)/runs.tsx`): the three groups of run-design
§5.4; rows for protocol runs show step fraction, elapsed, live timer;
badge for runs waiting on the person. Research rows unchanged.

**2.5 Timers**: on "start timer", schedule a local notification
(`expo-notifications`, `interruptionLevel: "timeSensitive"`) with category
`labee.timer` and actions *Done with step* / *Five more minutes*; cancel
on `cancelTimer`. The `Time Sensitive Notifications` capability goes in
`app.json` (`ios.entitlements`).

**2.6 Notification categories** (`src/notifications.ts`): `labee.question`
(up to four option actions, built from the push payload), `labee.reply`
(Reply text input → `POST …/turns`; Read in Labee), `labee.attention`,
`labee.timer`. Box side (`routes/link.ts` `handleMirror`): set
`categoryId` and `interruptionLevel` per push; include the question's
options in `data`.

**2.7 Deep links**: `labee://session/<id>?voice=1` opens the session with
Voice mode; `labee://session/new?voice=1` creates one; `labee://run/<id>`
opens the run screen.

**2.8 Config bridge, JS side only for now**: write the `{ base, hostId,
sessionToken }` record on sign-in / host change / sign-out through a stub
that becomes the native module in stage 3, so stage 3 has no app-state work.

Tests: `apps/mobile/test` unit tests for the step bar reducer and the
notification category builder; the web export (`expo export --platform
web`) still builds; a simulator pass with the fake claude for Start →
Done ×9 → Finish.

Exit: the §6 session of run-design done **by tapping** on a simulator with
the Mac-side server; a timer notification fires with its two actions on a
device.

## 4. Stage 3 — Siri v1: runs and sessions by phrase

Needs: a physical iPhone on iOS 26+, EAS build, and the config bridge.

**3.1 Native config module** (`modules/labee-siri/`): `configure(record |
null)` writes to the Keychain under service `online.labee.siri` with
`kSecAttrAccessibleAfterFirstUnlock`; `updateShortcuts()` calls
`LabeeShortcuts.updateAppShortcutParameters()`; `donate(intentName)`.

**3.2 Inline modules** (`apps/mobile/app-intents/`, enabled with
`experiments.inlineModules.watchedDirectories` in `app.json`):
- `LabeeAPI.swift`: `URLSession` client; headers `x-labee-session`,
  `x-labee-device: Siri`; host prefixing; 12-second deadline; typed errors
  for "not signed in", "host asleep", "no active run".
- `Entities/`: `ProtocolEntity` (from `/api/skills?kind=protocol`),
  `SessionEntity` (from `/api/sessions`), `MaterialEntity` (from the active
  run's `materials` + `amounts`), each with `suggestedEntities()` and
  synonyms.
- `Intents/`: every text-carrying intent calls `/api/siri/route` first
  and, on `candidates`, uses `requestDisambiguation` over them plus "New
  chat"; confirmations name the destination. StartRun (entity phrase), WhatsNext, Done, Back, Skip,
  StartTimer (step duration), SetTimer (duration parameter), Note
  (`requestValue`), StepDetails, HowMuch (entity, falls back to
  `requestValue` "Of what?"), WhereAmI, Pause, Resume, FinishRun; Tell,
  Answer, Status, Stop, NewChat, Talk from siri-design §2.2. Each with
  `supportedModes` as designed and `IntentDialog` strings written for the
  ear.
- `LabeeShortcuts.swift`: the phrases (max 10 App Shortcuts — group the
  run-progress phrases under one intent with an `AppEnum` action parameter
  {next, done, back, skip, where} so they count as one).
- `Shortcuts/LabNote.shortcut` link offered from Settings (dictate → Tell).

**3.3 Build**: EAS production profile; confirm App Intents metadata
extraction ran (`Metadata.appintents` in the archive) before TestFlight.

Tests: unit tests for the Swift parsing of API responses (XCTest target via
`expo-apple-targets`, or keep the Swift thin enough to skip); Shortcuts
app on the simulator for every intent's dialog; **device checklist** —
each phrase in run-design §3 and siri-design §2.2 from the lock screen
with the app killed, with the Mac asleep after start, with AirPods.

Exit: run-design §6 on a device without touching the phone after the
first phrase; siri-design §6's "tell" and "answer from the lock screen".

## 5. Stage 4 — Siri v2: questions and amounts

**4.1 Ask**: the Ask intent over `/api/ask/quick`; `requestConfirmation`
for escalation; one `OpensIntent` follow-up ("Anything else?").
**4.2 HowMuch tiers**: tier 1 via `/api/runs/:id/amount`; tier 2 via
quick ask with `runId`; tier 3 escalation. StepDetails reads the step's
full snapshot.
**4.3 Scale** (D5): StartRun asks the base volume when `base` is present;
tier-1 answers add the computed figure after the protocol's words.
**4.4 Reply action** on `labee.reply` pushes posts the dictated text as the
next turn; "Read in Labee" deep-links to Voice mode.

Tests: the amount tier-1 function against the seeded protocols (found /
not found / ratio with scale); device checklist for the §4.2 and §6
exchanges in run-design.

Exit: "how much TSS" answered from the protocol's words with the computed
figure; "how much water" answered honestly with the escalation offer.

## 6. Stage 5 — Lock screen and buttons

Live Activity (ActivityKit, widget target via `@bacons/expo-apple-targets`)
with the step text, timer and a Done `LiveActivityIntent`; Control Center
control for Done/Talk; Action-button docs. Chats-list progress marks.

Exit: Done from the lock screen advances the run.

## 7. Test plan summary

| Level | What | Where |
|---|---|---|
| Unit | parser, amounts, answer mapper, step-bar reducer, category builder | vitest, `apps/server/test`, `apps/mobile/test` |
| Server HTTP | runs API with a fake host over the link; finish → write-up with the fake claude | `apps/server/test/runs.*.test.ts` |
| Simulator | Start → Done ×N → Finish by tapping; every intent's dialog via the Shortcuts app; Type to Siri for phrase matching | manual, scripted with `idb` where it pays |
| Device | lock-screen phrases, Mac asleep, AirPods announce, timer actions, Reply action | manual checklist, one pass per stage 3–5 |
| Release | EAS build, TestFlight, App Store review notes updated (Siri phrases listed; no new data collection) | per stage |

## 8. Risks that change the plan

- If background cold start pushes a phrase past ~4 s on a mid-range
  iPhone, stage 3 adds an App Intents extension target
  (`expo-apple-targets`) and moves `LabeeAPI.swift` into it; the design
  already keeps the Swift free of app-process assumptions.
- If the ten-App-Shortcut limit bites, the run-progress enum (3.2) absorbs
  more verbs; Ask/Tell/Talk keep their own phrases.
- If the parser fails on a meaningful share of imported protocols, stage 2
  gains an "Ask Labee to structure this protocol" button on the preview
  sheet rather than a smarter parser.
- If SDK 58 stabilises before stage 3 starts, do the upgrade first and use
  `expo-app-intents` instead of raw inline modules.

## 9. What review should decide

1. The decisions in §0 are taken; review them once more against the
   updated designs.
2. Whether stage 1–2 (runs without Siri) is worth shipping on its own. The
   plan assumes yes; it is also the part the web and Mac apps see.
3. Minimum iOS 26 for the Siri build (D6), which determines whether the
   iOS 1.0 build under review is the last one for older devices.
