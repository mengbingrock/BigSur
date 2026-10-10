# Siri for Labee — design

Talk to the agent without touching the phone: ask a question, send it a
message, answer it, stop it, keep a conversation going — from the bench,
with gloves on, with AirPods in, from the lock screen. Everything goes
through the chat sessions that already exist; there is no new data model.

Status: design only, nothing here is implemented. Written 2026-10-09,
revised the same day to cover chat sessions only.
Builds on [mobile-companion-design.md](./mobile-companion-design.md) §7
(voice) and §8 (notifications). Apple's App Intents documentation was read on
2026-10-09; the facts in §2 are from it unless marked otherwise.

---

## 1. What people actually need at the bench

Three moments matter, and Siri fits them differently.

| Moment | Example | Hands | Wants back |
|---|---|---|---|
| **Quick question** | "How long does the Gibson protocol incubate?" | Busy | One sentence, within seconds, from *their own* protocols and chats. |
| **Steer the agent** | "Tell Labee the gel is done." · "Yes, use the second option." · "Stop." | Busy | Acknowledgement now, the result later. |
| **Work through something** | "Why did lane three come out faint?" and the back-and-forth after | Free for a minute | A real conversation, spoken. |

Siri is right for the first two: short, one-shot, no screen. For the third
it is a door, not the room — it opens Labee's own voice mode, which already
streams, speaks sentence by sentence and supports interruption. Apple gives
third-party apps no way to host an open-ended conversation inside Siri
(§2.3), so pretending otherwise yields a worse version of what the app has.

**Goals**

1. "Hey Siri, tell Labee…" works with the phone in a pocket and the app
   closed; the message is in the session and the agent is working on it.
2. A quick question gets a spoken one-sentence answer grounded in the
   person's protocols and recent chats within a few seconds, or an honest
   "I've sent that to your session".
3. The agent's questions and finished turns reach the person as
   notifications they can act on with one tap or by voice, read aloud on
   AirPods.
4. Nothing above needs a new permission prompt, and the first release needs
   no new Apple entitlement.

**Non-goals**

- Replacing Siri's conversation engine with Labee's model. Not offered to
  third parties; press reports of an iOS 27 "default assistant" setting have
  no developer documentation behind them.
- A notebook or runbook. Content a person wants kept goes into a chat, and
  the agent writes files from there as it does today.
- Apple Watch and CarPlay apps. The intents are reusable there later.
- Android.

---

## 2. How Siri reaches the app

### 2.1 App Intents; SiriKit is on its way out

Apple's framework is **App Intents**: Swift types describing an action, its
parameters and the phrases that trigger it. One definition is then offered by
Siri, the Shortcuts app, Spotlight, the Action button, Control Center and
widgets. The older SiriKit intent domains were deprecated at WWDC 2026. So:
App Intents only.

Four facts shape everything below:

| Fact | Consequence |
|---|---|
| A trigger phrase can carry only entity or enum parameters, never free text. Apple's own example of what *cannot* work: "Search my diary for X". | Asking and telling are a two-beat exchange: the phrase, then Siri asks for the text (§2.2). |
| An intent that runs without opening the app has **30 seconds** on iOS. `LongRunningIntent` (iOS 27) extends that if progress is reported. | Quick answers must come back well inside that; long work goes to the session and is reported by notification (§3.2). |
| Siri can ask clarifying questions inside one intent (`requestValue`, `requestConfirmation`, `requestChoice`, `requestDisambiguation`) and one intent can hand to another (`OpensIntent`). There is no API for an open-ended loop. | Siri handles one exchange and one follow-up; the conversation lives in the app (§2.3). |
| On iOS 27, Siri's new model understands third-party apps through **schema domains** and indexed entities; custom intents are reached only by their phrases. No schema domain describes an assistant or a chat. The Messages domain would, but it requires all five message schemas and presents Labee as a messaging app, a poor bet under App Review guideline 2.5.11. | Custom phrases, with sessions published as indexed entities so the new Siri at least knows their names (§2.4). |

### 2.2 The intents

| Intent | Phrase (always includes "Labee") | Mode | Says back |
|---|---|---|---|
| **Ask** | "Ask Labee" | background, then foreground if needed | The one-sentence answer, or "I've sent that to your session; I'll let you know." |
| **Tell** | "Tell Labee" · "Message Labee" · "Tell Labee in *MoE study*" | background | "Sent to 'MoE study'. I'll notify you when it answers." |
| **Answer** | "Answer Labee" · "Tell Labee yes" | background | "Okay, going with 'the second option'." |
| **Status** | "What's Labee doing?" | background | "Running 'MoE study' for 14 minutes: running tests." / "Waiting for you: which evaluator…" |
| **Stop** | "Stop Labee" | background | "Stopped." |
| **New chat** | "Start a new Labee chat" | background | "What should I send?" → "Started 'gel troubleshooting'. I'll notify you." (bypasses the router: always new) |
| **Talk** | "Talk to Labee" · "Talk to Labee about *MoE study*" | foreground | — (Voice mode opens on the session, listening) |

Each declares `supportedModes` (iOS 26): `[.background]` for the one-shots,
`[.background, .foreground(.deferred)]` for Ask so it can finish by opening
the session when the answer is more than a sentence, `[.foreground]` for
Talk. The free-text parameter is declared with a `requestValueDialog` and
fetched with `requestValue` in `perform()`, so Siri speaks the question and
takes the dictated answer:

```
You:   Hey Siri, tell Labee.
Siri:  What's the message?
You:   The gel is done, lanes one to six look fine, lane seven is faint.
Siri:  Sent to "gel troubleshooting". I'll let you know.
            (the router matched yesterday's chat about that gel; the Siri
             session logs: → gel troubleshooting · "The gel is done…")
```

Two beats is acceptable. For people who do it all day there is a one-beat
path: a Shortcut named "Labee" (dictate text → Tell), which Settings offers
as an installable link, so "Hey Siri, Labee, the gel is done…" is one breath.

### 2.3 Conversation: hand off, don't host

After "Ask" or "Tell", Siri's part is over. Continuation comes three ways:

- **One follow-up inside Siri.** Ask's result chains with `OpensIntent` to a
  fresh Ask whose question is empty, so Siri says "Anything else?" and takes
  one more. A bounded loop by design; whether Siri tolerates repeated
  chaining is untested, so the design relies on one hop only.
- **Context across phrases.** Every Siri exchange enters through one
  dedicated **Siri session**, which routes it to the right chat or starts a
  new one (§3.3). "Tell Labee the gel is done" → routed to "gel
  troubleshooting" → reply → "Ask Labee, so which lane?" is routed there
  too, so the agent knows which gel.
- **The app.** "Talk to Labee" opens Voice mode on that session: streaming,
  read-aloud, interruption, the client-side command grammar.

And an asynchronous loop that needs no Siri phrase (§4): the agent's reply
arrives as a notification, read aloud on AirPods, with a Reply action.

### 2.4 Entities: teaching Siri the names

Sessions and protocols are `AppEntity`s backed by queries over the person's
recent ones (`GET /api/sessions`, `GET /api/skills`), with `synonyms` in
their display representation ("Gibson", "Gibson assembly"). Siri then
resolves "Talk to Labee about *MoE study*" or "Ask Labee about the *Gibson*
protocol" to the item instead of garbling it. The app calls
`updateAppShortcutParameters()` after sign-in and whenever the lists change;
without that Siri keeps stale names. On iOS 27 the same entities are
indexed (`IndexedEntity`) so the new Siri finds them from a vague
description.

### 2.5 Other surfaces for free

The same intents appear in the Shortcuts app, Spotlight ("Ask Labee"), as an
**Action button** assignment (hold the button → "What's the message?" →
dictate), and as a **Control Center / lock-screen control**
(`ControlConfigurationIntent`) for Tell and Talk.

---

## 3. Server side

### 3.1 Where Siri requests go

Every intent calls the same HTTP API the app does, with the same session
token and host selection (`/api/hosts/:hostId/…` when a Mac is selected,
root paths otherwise), and `x-labee-device: Siri`. All of them need the
host that runs the sessions; when it is offline they say so plainly: "Your
Mac is asleep, so I can't reach your session." No silent failures, and
never a spinner that runs into the 30-second limit.

### 3.2 Quick answers

```
POST /api/ask/quick   { q, sessionId?, device: "siri" }
  → { answer, citations, needsAgent: false }
  → { answer: "", needsAgent: true, reason }
```

Built on `askLibrary` (retrieve over protocols, one model call, no tools),
with three changes for voice:

- The retrieval also covers the **last few messages of the target session**,
  so "what did it find?" works without the agent.
- The model answers in one or two spoken sentences, no markdown, units said
  in full ("five microlitres"). The fastest capable model (`haiku`), with a
  7-second server budget; the intent's own deadline is 12 seconds, leaving
  room for the cold start (§5.1) inside Apple's 30.
- It may answer `needsAgent` when the question needs files, calculation or
  the web. The intent then asks "Send it to your session?"
  (`requestConfirmation`) and starts a turn with `voice: true` and
  `device: "Siri"`. On iOS 27 Ask can instead adopt `LongRunningIntent` and
  wait for a short turn while reporting progress, which shows as a Live
  Activity with a stop button; an optimisation for later, not the base case.

### 3.3 The Siri session: one door, a router behind it

Every account has one session titled **Siri** (`kind: "siri"`, created on
first use, never archived, pinned at the top of Chats). All Siri phrases
that carry text — Tell, Ask, Answer, New chat, Start run — land there
first. It is not where the work happens; it is the switchboard and the log.

```
POST /api/siri/route   { text, kind: "tell" | "ask" | "start", protocolSlug?, sessionId? }
  → { sessionId, title, created: bool, confidence, candidates: [{ sessionId, title }] }
```

Routing, on the host, in order:

1. **Named.** The phrase carried a session entity ("Tell Labee in *MoE
   study*") → that session. No model.
2. **Pending question.** For Answer: the most recent session in
   `awaiting_input` → that session. No model.
3. **Active run.** A protocol run is in progress and the text reads as
   being about it (its material names, step words, "timer", "step") →
   the run's session. Cheap text match.
4. **The model.** One fast call (`haiku`, ~1 s) over the candidates — the
   last twenty sessions' titles, their last user and assistant lines, and
   any run state — returning `{ sessionId | "new", confidence }`.
5. **Unsure** (confidence low, or two close candidates) → the intent uses
   `requestDisambiguation` with the top two titles plus "New chat", so Siri
   asks "Which one: 'gel troubleshooting', 'ligation prep', or a new chat?"
   One beat, and the choice is logged so the router learns the pattern.
6. **New.** No fit → a new session titled from the text.

The message is then posted as a turn in the destination with
`device: "Siri"` and `voice: true`, and Siri's confirmation always names
the destination: "Sent to 'gel troubleshooting'." A wrong routing is heard
immediately; "Tell Labee in *ligation prep*" next time overrides it.

The Siri session's transcript is the audit trail: one system line per
exchange — what was heard, where it went, and for quick answers the
answer itself — so the person can scroll one place to see everything
they said at the bench and where it ended up. Nothing else is posted
there, and the agent never runs a turn in it.

"Answer" maps free speech onto the pending `AskUserQuestion`: an option's
label, its ordinal ("the second one"), "yes"/"no" for two-option questions,
else free text through the existing "Other" path (`formatAnswers`). The
mapping is server-side so Siri, the notification action and the in-app
voice command share one implementation. A turn sent while one is running
is queued, as the server already does; Siri says "Queued behind the
current turn."

### 3.4 What Siri heard

Siri transcribes "five microliters of T four ligase" and "16 degrees". A
message to the agent does not need normalising — the agent reads it in
context and asks if unsure — so the text is sent as dictated, and Siri reads
back only the first few words ("Sent: 'the gel is done…'"). The quick-answer
path is different: the question is matched against protocol names, so the
server corrects names against the person's protocol index before retrieval.
If more turns out to be needed, Apple's on-device Foundation Models
framework (iOS 26, Apple Intelligence devices) can clean dictation offline;
not in the first release.

---

## 4. Notifications close the loop

The box already pushes on `question_asked`, `turn_ended` and errors through
Expo's push service. Additions:

| Push | Category | Actions |
|---|---|---|
| Agent asked a question | `labee.question` | Up to four option buttons (the question's options) plus "Open". A tap answers without unlocking. |
| Turn finished | `labee.reply` | **Reply** (text input; the keyboard's dictation works) → `POST …/turns`; **Read in Labee** (opens Voice mode on the session). |
| Error / needs the Mac | `labee.attention` | Open. |

The categories are declared in the app (`expo-notifications`) and the box
sets the category per push.

**Read aloud on AirPods.** iOS's Announce Notifications reads time-sensitive
notifications from any app, so the box sends `turn_ended` and
`question_asked` pushes with `interruptionLevel: time-sensitive` (Expo's
push API passes it through; the app needs the Time Sensitive Notifications
capability, a checkbox rather than an application). The person hears the
agent's summary without touching the phone.

**Replying by voice to an announcement** is a different, heavier feature:
iOS only takes a spoken reply for *communication notifications*, which need
a Notification Service Extension, the Communication Notifications
capability and an `INSendMessageIntent` donation naming "Labee" as the
sender. That is a native extension target and an entitlement Apple reviews;
phase 3, and only if tap-then-dictate Reply proves too slow at the bench.

A **Live Activity** for a running turn (companion design §8) gets a Stop
button backed by the Stop intent, so the lock screen is enough to halt a
runaway turn.

---

## 5. Inside the Expo app

### 5.1 Swift in the app target, not a pod

App Intents are found at build time by Xcode's metadata extraction, which
only looks at code compiled into the app target. A normal Expo module (its
own CocoaPod) is invisible to it, so the intents cannot live there. Expo's
answer is **inline modules** (SDK 56+): Swift files in a watched directory
that `expo prebuild` compiles into the app target. Expo's own
`expo-app-intents` package (alpha, built for SDK 58) wraps exactly this with
an `app-intents/` folder, an entity catalog bridge and a JS hook for
invocations. The app is on SDK 57, so:

- **Now:** inline modules under `apps/mobile/app-intents/`, laid out so that
  moving to `expo-app-intents` is a rename.
- **When SDK 58 is stable:** adopt `expo-app-intents`.
- **If cold start hurts:** an App Intents extension target through
  `@bacons/expo-apple-targets`, which runs intents without launching the app.
  The Swift is written against a plain `URLSession` client so it does not
  care which process it runs in.

```
app-intents/
  LabeeShortcuts.swift          AppShortcutsProvider: the phrases
  Intents/                      one file per intent in §2.2
  Entities/                     SessionEntity, ProtocolEntity (+ queries, synonyms)
  LabeeAPI.swift                sessions, turns, answer, cancel, ask/quick
  Config.swift                  base URL, host id, session token (Keychain)
modules/labee-siri/             tiny Expo module: configure(), updateShortcuts(), donate()
```

The intents do **not** call into JavaScript. iOS launches the app in the
background to run an intent from the main target; the Swift code does its
HTTP call and returns its dialog whether or not the React Native bridge has
finished booting.

### 5.2 Sharing the sign-in

The session token lives in `expo-secure-store` and the base URL / host id in
AsyncStorage. Rather than read those stores from Swift, the app pushes what
the intents need through the module whenever it changes:

```ts
LabeeSiri.configure({ base, hostId, sessionToken });   // after sign-in, host change, token refresh
LabeeSiri.configure(null);                              // on sign-out and account deletion
```

The module keeps it in the Keychain under its own service name with
`kSecAttrAccessibleAfterFirstUnlock`. That accessibility matters:
`expo-secure-store`'s default is "when unlocked", and a Siri request from
the lock screen runs while the phone is locked. An intent that finds no
configuration says "Sign in to Labee first" and offers to open the app.

### 5.3 Opening the app at the right place

"Talk to Labee", the notification's "Read in Labee" and the intents' open
fallbacks use the existing `labee://` scheme:

```
labee://session/<id>?voice=1      Voice mode on that session
labee://session/new?voice=1       a new session, Voice mode
```

`expo-router` already handles `labee://auth`; these are two more routes.

### 5.4 Suggestions

After an in-app voice message the app donates the Tell intent, so Siri
Suggestions and the lock screen offer "Tell Labee" at the times of day the
person usually does it.

### 5.5 Testing

- Shortcuts app on the Simulator runs App Shortcuts and shows the dialogs;
  "Type to Siri" (Accessibility) exercises phrase matching without a
  microphone.
- Voice, AirPods, lock screen and Announce Notifications need a device.
- iOS 27 adds `AppIntentsTesting` (XCUITest) for driving intents and entity
  queries out of process; worth adopting once the minimum OS allows.

---

## 6. Example sessions

**Sending the agent an update, phone in pocket, AirPods in**

```
You:   Hey Siri, tell Labee.
Siri:  What's the message?
You:   The gel is done, lanes one to six look fine, lane seven is faint.
Siri:  Sent to "gel troubleshooting". I'll let you know.
            (the router matched yesterday's chat about that gel; the Siri
             session logs: → gel troubleshooting · "The gel is done…")
   …  (a minute later, AirPods, time-sensitive notification)
       "Labee: Lane seven is likely under-loaded; the ligation volumes
        differ from the protocol. Want me to recompute them?"
```

**Quick question, answered from their own protocol**

```
You:   Hey Siri, ask Labee.
Siri:  What's your question?
You:   How long does the Gibson protocol incubate?
Siri:  Fifteen minutes at fifty degrees, per your Gibson assembly protocol.
       Longer for more than three fragments. Anything else?
You:   No.
```

**Question that needs the agent**

```
You:   Hey Siri, ask Labee.
Siri:  What's your question?
You:   Compare today's yields with last week's and tell me if the new buffer helped.
Siri:  That needs your files. Send it to your session?
You:   Yes.
Siri:  Sent. I'll let you know.
   …  "Labee: Yields are up 30 % on average with the new buffer, but lane
        four is an outlier. Want the table?"
   tap Reply, dictate "Yes."   →   the next turn
```

**Answering the agent from the lock screen**

```
   (notification)  Labee is asking: which evaluator for the discovery stage?
                   [Command] [LLM rubric] [Other…] [Open]
   tap [LLM rubric]  →  the turn continues on the Mac
```

**Going deeper**

```
You:   Hey Siri, talk to Labee about MoE study.
   →   the app opens in Voice mode on that session, already listening
```

---

## 7. Phases

| Phase | Deliverable | Exit condition |
|---|---|---|
| 1 | Server: the Siri session and router (`/api/siri/route`), `/api/ask/quick`, server-side answer mapping for `AskUserQuestion`. App: notification categories with actions, time-sensitive pushes, `labee://session/…?voice=1` routes, the config bridge. | A question push can be answered from the lock screen; a finished turn is read aloud on AirPods; Reply sends the next turn. |
| 2 | Siri v1: inline-module intents Tell / Answer / Status / Stop / Talk / New chat, session entities, "Labee" shortcut link, Action-button and Control Center entries. | On a device: "Tell Labee" with the app closed starts a turn; the Mac shows *Siri* on the message; works from the lock screen. |
| 3 | Siri v2: Ask (quick answers, one follow-up, escalation), protocol entities, Live Activity Stop. Then, if needed: communication notifications for spoken replies; `LongRunningIntent` Ask on iOS 27; `expo-app-intents` on SDK 58. | A full loop — ask, escalate, hear the reply on AirPods, reply — without touching the phone. |

Phase 1 is useful on its own and is the only part the web and Mac apps
notice (the Siri session appears in Chats; the answer mapping). Phases
2–3 are iOS-only.

---

## 8. Risks and open questions

- **Siri's speech recognition on lab vocabulary.** It is Apple's recogniser;
  we cannot add words. Mitigations: entities with synonyms (§2.4), the agent
  reading messages in context, name correction before quick-answer
  retrieval (§3.4).
- **Background launch cost.** Each background intent starts the app
  process. Siri's 30-second clock makes a slow cold start a correctness
  problem, not only a feel problem; the extension target (§5.1) is the fix
  and the Swift allows it from day one.
- **Alpha tooling.** `expo-app-intents` is alpha and targets SDK 58 (RN
  0.88). Inline modules on SDK 57 avoid depending on it now; the upgrade is
  its own task.
- **The new Siri.** Apple's iOS 27 Siri routes third-party requests through
  schemas and indexed entities; custom phrases keep working but may be
  chosen less often, and there is no schema for an assistant. Indexed
  session entities are the only hedge available.
- **Chaining limits.** One `OpensIntent` hop is designed in; more is not,
  until tested on a device.
- **Decided (2026-10-09):** Siri messages do not go to the most recent
  session. They enter one dedicated Siri session that routes them (§3.3) —
  to the right chat, or to a new one. The cost is a routing call (~1 s)
  and an occasional "which one?"; the gain is that a wrong guess never
  lands in a session the person was not thinking of.
- **Risk of the router:** its model call is on the critical path of every
  Tell. Steps 1–3 avoid it for the common cases (named session, pending
  question, active run), and the 12-second intent deadline covers it when
  it runs.

## 9. Lab mode: when Siri can't hear "Labee" (added 2026-10-10)

On the first device test (iOS 27) Siri did not recognize "Labee" in the
user's voice. Every App Shortcut phrase must contain the app's name, so a
misheard name breaks every phrase. Two changes, one small and one large:

**Easier names for Siri.** `INAlternativeAppNames` in `app.json` adds
"Lab Bee" (with a "lab bee" pronunciation hint), "Lab Helper" and "Lab
Assistant". Apple caps it at three per language. Every existing phrase now
also works with those names, for example "Lab Helper, done".

**Lab mode, which needs no Siri at all during a run.**

- *One press in.* `labee://voice` opens the run in progress, or a new chat
  when nothing is running, in Voice mode and already listening. The Control
  Center control ("Labee Lab Mode") opens it, so it can sit on the Action
  Button or the Lock Screen.
- *Tap to talk, no holding.* One tap listens; it stops by itself after
  speech and a 1.2 s pause, measured against the room's own background level
  so a fume hood doesn't keep it open (`src/hooks/speechEnd.ts`). Nothing said
  for 6 s drops the clip; 20 s is the cap.
- *The app's own speech recognition.* The clip goes to `/api/transcribe`
  like any voice message, which has no trouble with lab words or the app name.
- *Commands handled on the phone.* `parseRunCommand` in session-core matches
  short whole utterances: done, back, skip, where am I, what's next, how much
  <material>, timer <length>, cancel timer, time left, note <text>, pause,
  resume, finish run. They act on the run and the phone answers aloud
  (`src/runs/voice.ts`). Anything longer goes to the agent as before.
- *Big type.* The voice screen shows the current step and the commands it
  understands.

Starting a run now also asks for notification permission, since timer alerts
and the notification buttons depend on it.

Not verified yet: real microphone input on a device. The simulator's
microphone did not pick up audio played on the Mac, so the end-to-end voice
path was checked in pieces: opening and auto-listening in the simulator,
transcription of a recorded "okay, done" on the server ("OK, done."), and the
parser, replies and end-of-speech detector in unit tests.
