> The default router implementation is now described in [Siri context implementation](siri-context-implementation.md). Fixed snapshot/one-read behavior below remains the legacy fallback selected by `LABEE_SIRI_CONTEXT=0`.

# The Siri agent: Labee from the lock screen

*Design, 2026-10-10, revised the same day. Follows `siri-design.md`
(phrases, the Siri session, notifications) and `protocol-run-design.md`
(runs). It replaces §3.3 of the Siri design, where the Siri session is a
switchboard that never acts, with a Siri session that plans and acts. The
first draft gave the Siri session a full agent loop over an MCP server;
§12 says why that was dropped for a planner.*

## 0. What the log showed

The first day on a real iPhone (iOS 27) produced this, in the order it
happened. Each line is from the Siri session's transcript or the servers'
logs.

| Said to Siri | What happened | What should have happened |
|---|---|---|
| "What protocols are running" (heard as "podcast") | Quick answer read the run state correctly. | Fine. |
| "Stop all the running protocols" | Quick answer: "The protocol doesn't specify." | Pause both runs and say so. |
| "The first passcode is running out…" (misheard) | Quick answer explained NEEDS_AGENT aloud, in model-speak. | "I didn't catch that. Say it again?" |
| "Tell him that I'm hungry" | A new chat was opened; the agent replied, in plan mode, that it cannot send messages. Siri had said "I'll let you know." Nothing came back. | Siri: "I can't message people. Did you mean a chat?" |
| "Ask Labee what are PCR stats" | New chat, turn finished. "I'll let you know." Nothing came back. | The answer, announced on the AirPods and readable with one phrase. |

Two causes, one shallow and one deep.

**Shallow: no push could ever reach the phone.** `/api/link/push-token`
required the pairing token a phone gets from the desktop's Devices screen.
A phone signed in with Apple or Google has no such token, so every
registration was refused (status 400, five times in the log) and
labee.online held no push token for the phone. Fixed in commit `94aece5`: a
signed-in phone registers itself by its push token, and the app re-sends the
token on every launch. Deployed.

**Deep: nobody is in charge.** The Siri session is a router that picks a
chat and logs a line. It cannot act ("stop the runs"), cannot decline
("tell him"), and once it has handed a message to another chat it has no
part in what comes back. The quick-answer path is a retrieval prompt, so it
answers commands as if they were questions about a protocol. The "return"
is a generic push that fires only when nobody is watching the chat and
carries the first 140 characters of whatever the agent wrote, with no
notion that Siri asked. The person at the bench is left holding the phone.

## 1. The idea

The Siri session becomes an agent: the **Siri agent**. Every spoken phrase
that carries text is one exchange in it. It can act on all of Labee: the
chats, the runs, the protocols, the phone's own notifications. It answers
in a sentence Siri can read within Siri's time limit, or it starts work
somewhere else and makes sure the result comes back to the person's ear.
Inside, it is a planner (§3): one model call that returns the sentence and
the actions, and a server that carries the actions out.

Three rules give it its shape.

1. **One voice.** Whatever was said, the Siri agent replies. It may delegate
   the work to another chat, but it is the one that reports back, in spoken
   length, naming where the work is.
2. **Act, don't retrieve.** "Stop the runs" pauses runs. "How much TSS"
   reads the run. "Compare the two transfection protocols" starts a chat.
   The plan says what is a question and what is a command; the agent
   never answers a command with a passage.
3. **Everything returns.** Work that outlives the phrase comes back through
   the Siri agent: a line in the Siri session, an announcement on the
   AirPods, and a phrase ("Any news from Labee?") that reads it aloud on
   request. Nothing finishes silently.

## 2. Constraints, from the device

- **Thirty seconds.** An App Intent run from Siri has about 30 s to return,
  and Siri may wait less. Anything spoken back by Siri must be ready inside
  `perform()`. Longer work must be handed off and reported later
  ([Apple engineer, developer forums](https://developer.apple.com/forums/thread/764501)).
- **The lock screen.** An intent runs on a locked phone only if it does not
  open the app and declares `authenticationPolicy = .alwaysAllowed`; opening
  the app always asks for Face ID. So the Siri agent's intents all run in the
  background and never open the app. Only "Talk to Labee" (Lab mode) opens
  it, and that one is for an unlocked phone with the screen kept awake.
- **AirPods.** iOS announces time-sensitive notifications from any app when
  Announce Notifications is on. That is the return channel: a push with
  `interruptionLevel: time-sensitive` is read aloud, hands free, locked.
- **Phrases must carry the app name** on Siri Classic, and the name is
  often misheard. "Lab Helper", "Lab Bee" and "Lab Assistant" are accepted
  (`INAlternativeAppNames`). Siri AI on iOS 27 understands apps through
  App Schemas, without fixed phrases; that is phase 3.
- **Hearing.** Siri's dictation of "TSS" or "PEI" is poor. The Siri agent
  gets the person's protocol names and material names in its prompt, so it
  reads "tee ess ess" as TSS; the quick-answer path already corrects names
  the same way.

## 3. What the Siri agent is

A session of `kind: "siri"`, one per account, titled "Siri", pinned, never
archived (as today). New: it acts, through a **planner**: one fast model
call that returns a sentence to speak and a short list of actions, which
the server then carries out itself. No agent loop, no CLI spawn, no tools
handed to a model.

**Where it runs.** Where the Siri session lives: on the selected Mac
through the Device Link, else on the box with the provided tier. The box
owns the runs either way and the run functions reach it from the Mac, as
the run routes do today, so the planner sees the same state from either
place.

**The route.** The Say intent posts the phrase; the route gathers state,
resolves the phrase against the open exchange, plans, validates, confirms
or executes, and answers. It has a **spoken budget** of 10 s: what is ready
by then is spoken; what is not is promised and delivered when it comes.
Time is never a reason to guess or to open a chat.

```
POST /api/siri/say   { text, device: "Siri" }
  → { status: "answered", spoken, actions: [...] }
  → { status: "working",  spoken: "Started 'compare transfections'. I'll tell you.", actions: [...] }
  → { status: "working",  spoken: "Give me a moment. I'll tell you." }          (past the budget)
  → { status: "confirm",  spoken: "Pause both runs?", confirmId }
POST /api/siri/say   { text: "yes please" }   or   { confirmId, yes: true }
```

`answered` is spoken by Siri and that is the end of it. `working` means the
answer comes later through §5: a chat was started or continued, or the
plan itself was not ready in time, in which case it is executed when it
arrives and its sentence is announced like a chat's return. `confirm` is
for the few actions that should not happen on a misheard word (§6): the
intent uses `requestConfirmation` and re-posts with the `confirmId`; in the
app, or when Siri hears the next phrase, a plain "yes" or "no" answers it
without a model call, because the exchange remembers the question.

**The exchange.** Context is not a window of recent messages; it is the
request being worked on. An exchange opens with a phrase and holds every
line said about it, the question Labee asked back (a confirmation, or a
clarifying question), and the chats Labee started for it. It closes when
the request is done: the action ran, the person said no, or the delegated
chats returned. The next phrase is resolved against the open exchange: the
model sees the request, the lines so far, what is pending, and says
whether this phrase continues it or starts something new. When nothing is
open, the model also sees the last settled exchange in one line, for "do
that again" or "the other one". The exchange is stored with the Siri
session, so it survives a restart, and a confirmation pending in it expires
after two minutes. Nothing in this depends on how many messages there were
or how many words the person said.

**The state**, gathered in milliseconds from local calls and about 1.5 KB of
text: the clock; the runs in progress with their step, amounts, timers and
notes (`runs.service.viewOf`); the last ten chats with status, pending
question, and last user and assistant lines (the router's `tailOf`); the
person's protocol names; and the unread returns (§5). Every id the model
may name is in this state, which is what makes validation possible.

**The call.** One message to the model per phrase: the phrase, the
exchange, the previous exchange and the state, as JSON; a fixed system
prompt of about a page with the rules of §1 and the action vocabulary;
`effort: low`, a fast model. On a Mac the only sanctioned route to the
model is the Claude command line tool, and starting it costs 2 to 5 s, more
than the answer itself. So the planner keeps **one warm process per
account** (`services/siri/warm.ts`): the tool is started once with the
system prompt, fed each phrase over its standard input, and answers in
about a second from the second phrase on; it is closed after ten minutes
idle and restarted after forty phrases. On labee.online, which has no
command line tool and a direct credential, the same message goes through
the direct completion. The prompt is terse and spoken, never lists options
as a menu, names a delegated job ("Started 'compare transfections'"), and
declines what Labee cannot do. A plan that names an id the state does not
hold, or proposes a confirmation without the actions it would confirm, is
sent back to the model once with the reason; a second bad answer is
reported as such ("I couldn't do that. Say it again?"), never guessed at
and never turned into a chat.

**The plan**, JSON, validated against a schema before anything runs:

```json
{
  "say": "Paused both runs. TSS is at step 4; its timer is still going.",
  "actions": [
    { "do": "runs.pause", "runId": "run_d4c6" },
    { "do": "runs.pause", "runId": "run_fc11" }
  ],
  "need": null,
  "confirm": null
}
```

The vocabulary is closed. Each action maps to a service function the
server already has; the executor is a switch, not a server.

| Action | Does | Backed by |
|---|---|---|
| `runs.advance` / `back` / `skip` / `pause` / `resume` / `finish` | a run step | `runs.service` |
| `runs.note { runId, text }` | file a note on the current step | `runs.service.note` |
| `runs.timer { runId, seconds? }` | start the step's timer, or one of a length | `runs.service.startTimer` |
| `runs.amount { runId, material }` | the tiered amount, scaled | `runs/amount.answerAmount` |
| `runs.start { protocolSlug, scale? }` | start a run | the `POST /api/runs` handler's function |
| `chats.send { sessionId, text }` | continue a chat | `runner.startTurn` with `origin: siri` |
| `chats.new { title, text }` | start a chat with a first message | `sdb.createSession` + `runner.startTurn` |
| `chats.answer { sessionId, spoken }` | answer the question a chat waits on | `mapSpokenAnswer` + `runner.answer` |
| `chats.stop { sessionId }` | stop a running turn | `runner.cancelTurn` |
| `chats.read { sessionId, last }` | the last messages (a `need`, not an action) | `sdb.listMessages` |
| `ask.quick { q }` | the retrieval answer for a pure protocol question | the quick-answer function |

A plan with an unknown action, an id not in the state, or malformed JSON is
rejected whole; the fallback is today's behaviour, the phrase goes to a new
chat and Siri says so. An unknown or empty phrase ("The first passcode is
running out") gets `say: "I didn't catch that. Say it again?"` and no
actions; the prompt is told that silence beats a guess.

**`need`: one more look.** A plan may ask for one read before deciding:
`{ "need": { "do": "chats.read", "sessionId": "ses_…", "last": 6 } }`. The
route fetches it, appends it to the prompt, and calls again. Two rounds is
the cap. This covers "what did the gel chat conclude" and "what is it
waiting for" without a loop.

**The transcript.** The Siri session stays the audit trail and becomes
readable: the phrase as a user message, `say` as an assistant message, one
system line per executed action with `device: "Siri"`, and one line per
return (§5). It replays the day, and it is the test corpus (§9).

## 4. The two lanes

```
phrase ──► /api/siri/say ──► exchange + state (ms) ──► warm planner (≈1 s; 4 s when cold)
                │                                            │
                │ plain yes/no to a pending confirmation     │
                └──► execute the pending plan, no model      │
                                                             │
        ┌────────────────────────────────────────────────────┴─────────────────┐
        │ ready inside the spoken budget (10 s)                                │ not yet ready
        ▼                                                                      ▼
   validate; confirm or execute;                                 Siri: "Give me a moment. I'll tell you."
   Siri speaks what was done, or the chat it started             the plan finishes in the background,
        │                                                        executes, and is announced (§5)
        │ a chat was started or continued (origin: siri)
        ▼
   the chat's turn runs for minutes ──► turn_ended / question_asked
                                              ▼
                              delivery (§5): Siri line + announced summary
                                 + unread for "Any news from Labee?"
                                 + the exchange settles
```

The fast lane is 1 to 3 s spoken once the process is warm; most of a bench
day lives there. The slow lane is where the real agent works, with every
tool it has today, and the planner is only its dispatcher and its voice.
Nothing crosses from fast to slow because of time alone: a late plan is a
promise kept, not a chat.

## 5. The return path

A turn started by the Siri agent carries `origin: { kind: "siri",
siriTurnId }` in its request body, which lands in the session's `lastBody`
and on its `turn_started` event. When that turn ends, or asks a question,
the server that holds the chat does three things, in this order, and the
box mirrors them if the chat is on a Mac:

1. **A line in the Siri session**, as a system message:
   `← "compare transfections": PEI is cheaper per plate; lipofection gives…`
   (first 200 characters of the reply, or the question with its options),
   with meta `{ origin: "siri", sessionId, unread: true }`.
2. **A push, announced.** Category `labee.reply` (or `labee.question`),
   `interruptionLevel: time-sensitive`, title the chat's name, body a
   **spoken-length summary** rather than the first 140 characters: the
   Siri agent makes it. The box makes one more short completion with
   the reply as input and the instruction "summarise for the ear in two
   sentences; say what it needs from the person, if anything". That is
   the voice the person hears on the AirPods. The push data carries
   `sessionId` and `siriTurnId`; the Reply and Answer buttons work as they
   do now.
3. **Unread.** The line stays unread until it is read back or the chat is
   opened. A new phrase, **"Any news from Labee?"** (`CatchUpIntent`,
   background, `.alwaysAllowed`), reads unread returns aloud, newest first,
   one per breath, and marks them read: "From 'compare transfections': PEI
   is cheaper per plate… From 'TSS run': the ten-minute timer is done."
   With nothing unread: "Nothing new. Two runs are going: TSS at step 4,
   PEI at step 1."

The suppression that exists today, no push while someone is watching the
chat, does not apply to Siri-origin turns: the person asked by voice and
expects a voice back, whatever a screen somewhere is doing.

A question from a delegated chat is a return too. It is announced ("'gel
troubleshooting' asks: which ladder did you load? One kilobase, or one
hundred base pair?") and "Answer Labee" maps the spoken answer onto the
options as today. The Siri agent is told about it on its next turn, so
"what's it waiting for?" has an answer.

## 6. Safety and confirmation

The Siri agent can act. Misheard words must not cost a run, so the limits
live in the executor, where no model output can reach past them.

- **Free:** every read, `runs.advance` / `back` / `note` / `timer` /
  `pause` / `resume`, `chats.send`, `chats.new`, `chats.answer`,
  `chats.stop`.
- **Confirmed** (`status: "confirm"`, Siri asks "Finish the TSS run?"):
  `runs.finish`, `runs.start` when a run of that protocol is already going,
  and more than one write in a single plan. The executor refuses these
  unless the plan arrived through the `confirmId` path, whatever the model
  wrote.
- **Never from Siri:** abandoning a run, deleting a chat, anything
  billing. There is no action for them; the prompt says to open the app.

Every action is a system line in the chat or run it touched, with
`device: "Siri"`, as run events are today.

## 7. Phrases, fewer of them

The ten App Shortcuts become eight. Run verbs stay as they are: they are an
enum, instant, and need no model.

| Say | Intent | Lane |
|---|---|---|
| "Tell Lab Helper …" / "Ask Lab Helper …" / "Lab Helper, …" | **SayToLabee** (free text asked for if absent) | both; the agent decides |
| "Any news from Lab Helper?" | **CatchUp** | fast |
| "Answer Lab Helper" | Answer (as today) | fast |
| "Lab Helper, done / next / back / skip / where am I / pause / resume / finish the run" | RunStep (as today) | fast, no model |
| "Start a Lab Helper timer for ten minutes" | StartTimer (as today) | fast, no model |
| "How much TSS in Lab Helper" | HowMuch (as today) | fast, no model |
| "Start TSS in Lab Helper" | StartRun (as today) | fast |
| "Talk to Lab Helper" | Lab mode (opens the app) | unlocked only |

Tell and Ask collapse into one: the distinction was for the router, and the
agent does not need it. Every intent above except Talk declares
`supportedModes: .background` and `authenticationPolicy: .alwaysAllowed`
(today only the lock-screen Done button does), so all of them work on a
locked phone. "What's Labee doing" and "Stop Labee" fold into SayToLabee.

## 8. Example sessions

**At the bench, locked phone, AirPods.**

> "Lab Helper, stop all the running protocols."
> *(state: two runs in progress; plan: two `runs.pause`; two writes →
> confirm)*
> Siri: "Pause both runs, TSS and PEI transfection?"
> "Yes."
> Siri: "Paused. TSS is at step 4 with a timer running; I left the timer.
> PEI is at step 1. Say resume when you're back."

> "Ask Lab Helper what are PCR stats."
> *(no protocol named "PCR stats" in the state; the prompt's rule is that
> a question beyond the protocols is a chat, not a quick answer; plan:
> `chats.new("PCR statistics", …)`)*
> Siri: "I've started a chat called 'PCR statistics'. I'll tell you when
> it answers."
> *(ninety seconds later, announced)* "Labee, from 'PCR statistics': a
> typical PCR runs thirty cycles of denaturing at ninety-five, annealing
> at fifty-five to sixty-five, and extension at seventy-two; it asks
> whether you want stats for a specific polymerase."
> "Answer Lab Helper: Q5."
> Siri: "Okay, going with Q5 in 'PCR statistics'."

> "Tell Lab Helper that I'm hungry."
> *(no chat fits; the agent declines rather than spawns)*
> Siri: "I can't message anyone, and that doesn't sound like it's for a
> chat. Want me to note it on the TSS run?"

**In the office, later.**

> "Any news from Lab Helper?"
> Siri: "Two things. From 'compare transfections': PEI is about a tenth
> the cost of lipofection per plate, with lower efficiency in HEK293T; it
> wrote a table in the chat. And the TSS run's ten-minute timer finished
> at 3:42. That's all."

## 9. Server changes

- **`services/siri/planner.ts`.** `gatherState(email)`; the exchange
  (`Exchange`, `Pending`, stored in the Siri session's `lastBody.siri`,
  `settleDelegation` called by delivery); `planWith(email, ctx)` (the model
  call and the JSON parse, one retry with the reason); `validatePlan`,
  `needsConfirmation`; `executePlan` (the switch over service functions,
  each write returning its spoken sentence); `finalSentence`;
  `sayToLabee` (the exchange end to end, with the spoken budget and the
  late path). Pure enough to test with a recorded model reply and a fixture
  state.
- **`services/siri/warm.ts`.** One Claude command line process per account,
  `--input-format stream-json`, no tools, the system prompt fixed at spawn;
  asks are serialised; idle close after ten minutes, restart after forty
  phrases, fallback to the one-shot completion when it cannot run.
  `LABEE_SIRI_WARM=0` turns it off (the tests do; the fake model is one-shot).
- **`POST /api/siri/say`** in `routes/siri.ts`, replacing `/api/siri/send`
  for the Say intent: resolve against the exchange, plan, validate, confirm
  or execute, answer within the spoken budget, else promise and announce
  later (`announceLate` in delivery). `/api/siri/route` stays for Answer
  (pending-question lookup) and StartRun's resume check. The quick answer
  stays as a function the executor calls for `ask.quick`; its route remains
  for the HowMuch fallback.
- **The Siri session's messages.** The phrase and `say` are written as user
  and assistant messages through `sdb`, without a runner turn; action lines
  through `emitSystemMessage`. The session's status never becomes
  `running`, so it is never "watched" and never queued behind.
- **Origin on turns.** `TurnRequest.origin?: { kind: "siri"; siriTurnId }`
  in session-core; carried on `turn_started`; read on `turn_ended` and
  `question_asked` by the delivery code.
- **Delivery.** `services/siri/delivery.ts`: on `turn_ended` /
  `question_asked` of a Siri-origin turn, write the Siri line, make the
  spoken summary (a second `completeText`), push. On the box this runs in
  `handleMirror` for Mac-held chats and in the runner's listener for
  box-held ones. The "being watched" suppression is skipped for Siri
  origins.
- **Unread.** `GET /api/siri/news` returns unread returns; `POST
  /api/siri/news/read` marks them. The Siri session's system-message meta
  holds the flag; no new table.
- **Intents.** SayToLabee, CatchUp; `.background` and `.alwaysAllowed` on
  every Siri intent; the App Shortcuts list trimmed to eight.

The run-side code, the Lab mode, the agent sessions and the notification
categories are unchanged. No new server, no new token, no change to how
agent turns run.

## 10. Phases

1. **Return first** (small, this week). Push registration (done). Siri
   lines, announced summaries and unread on Siri-origin turns, using the
   present router to mark origin. The CatchUp intent. `.alwaysAllowed` on
   every Siri intent. Verifiable on the phone with "Ask Labee" then "Any
   news from Labee?".
2. **The planner.** `planner.ts`, `/api/siri/say`, the SayToLabee intent,
   confirmation. The router becomes the planner's fallback and the quick
   answer one of its actions rather than entry points.
3. **Siri AI.** App Schemas for the run and chat entities so iOS 27's Siri
   understands "I'm done with this step" without a phrase or an app name.
4. **A Live Activity for the Siri agent**: the last answer on the lock
   screen, with Done and Answer buttons, so a glance replaces a phrase.

## 11. Open questions

- **Cost.** One short completion per phrase (two with a `need`), plus one
  per return for the summary. A fraction of a cent each, the same as the
  quick answer today. Worth a counter in Settings.
- **Latency on the Mac path.** A phrase travels phone → box → Mac → model →
  back: relay 100–200 ms each way, state under 50 ms, the call 0.8–2 s,
  execution up to 1 s when a turn starts. Expect 2–4 s spoken, 5–7 with a
  `need`. A sleeping Mac means the box runs the call itself on the provided
  tier, as the router does today, and the Anthropic resale clause noted in
  `provided-device-design.md` applies to that.
- **Two phones.** Returns go to every registered phone of the account.
  Unread is per account, so a return read on one phone is read on both.
- **What Siri AI will do with our intents** before phase 3 is still
  unmeasured; the layered test in the plan's execution log applies.

## 12. Why not an agent with an MCP server

The first draft ran each phrase as a turn of the Claude CLI in the Siri
session, with a `labee` MCP server giving it typed tools. It was dropped
for the planner, for reasons that follow from §2:

- **Time.** The CLI takes 2–5 s to start before any token; the MCP
  handshake and each tool round add more. A 12 s budget was mostly
  overhead, and the Mac path left little margin inside Siri's 30 s.
- **Cost.** A full agent turn per phrase, with tool schemas and several
  rounds, against one short completion.
- **Moving parts.** A new HTTP server, per-account tokens, a supervisor to
  cut turns at the budget, a `say` tool to answer early; each a way to fail
  from the lock screen.
- **Safety.** An agent asks for confirmation when it chooses to; the
  executor refuses by construction.
- **Testing.** The planner is tested with a fixture state and a recorded
  reply; the agent needed a live CLI and server.

What the agent could do and the planner cannot is explore: read several
chats, search twice, change its mind. That work is delegated to a chat,
which is a full agent with every tool. The MCP server comes back only if
that split stops holding.

## 13. Built (2026-10-10)

All four phases are on `worktree-siri-runs`, the server side deployed to
labee.online and the app side in build 17.

- **Phase 1, the return path:** `services/siri/delivery.ts`, the `origin`
  field on turns and their events, `GET /api/siri/news` and `POST
  /api/siri/news/read`, the Any-news intent, `.alwaysAllowed` on every
  background intent. Test: `test/siri.delivery.test.ts`.
- **Phase 2, the planner:** `services/siri/planner.ts` (state, plan,
  validate, confirm, execute), `POST /api/siri/say`, the quick answer as a
  function (`services/siri/quick.ts`), the Say intent in place of Tell, Ask,
  New chat and Agent status; eight shortcuts. Test:
  `test/siri.planner.test.ts` (validation and confirmation pure; the HTTP
  path with the fake model returning the plan).
- **Phase 3, the index:** chats and runs are `IndexedEntity` with a
  `CSSearchableItemAttributeSet`; `LabeeIndex.refresh()` runs after sign-in
  and after each Say. What this does not include: an App Schema domain.
  Apple's domains (mail, messages, photos, books, reminders, system, …) have
  none for laboratory runs, and the entity schemas carry fixed property
  sets, so chats and runs stay custom entities. Siri AI can refer to them
  by meaning through the index; it cannot execute "I'm done with this step"
  without a phrase until a fitting schema exists.
- **Phase 4, the lock screen:** `SiriActivity` in the widget target, shown
  by the Say and Any-news intents, with Any news (a `LiveActivityIntent`,
  in place), Done (the run's intent) and Open. It is started from the
  intents, which run in the app's process; a return that arrives while the
  app is not running reaches the phone as the announced push, and the
  activity catches up on the next phrase or button press. Updating it from
  the server would need ActivityKit push tokens, which Expo's push service
  does not carry.

Not verified on a device: everything spoken. The simulator checked the
intents' metadata (eleven in the app, three in the widget) and the native
build; the server paths are covered by tests.

## 14. The second device day, and what the first build got wrong

"Finish the first step of the first protocol" produced, in order: a
confirmation question with no action behind it, a yes that did nothing,
and a new chat called "Yes, please." Three causes, all in the planner as
first built, all of them guesses standing in for design:

- **A fixed timeout as a decision.** Every call on the Mac took a little
  over six seconds, because each one started the command line tool from
  cold, and the planner gave six. Past the timeout it opened a chat, so
  slowness became a wrong action. The fix is not a longer timeout: the
  model is reached through a warm process, so the usual answer takes a
  second, and when an answer is still late Siri hears "give me a moment"
  and the real answer follows through the return path. A chat is only ever
  started because the plan says so.
- **A window as context.** The first repair added "the last eight
  exchanges" to the prompt. That is a guess about where the context is. The
  exchange (§3) is the context: the request being worked on, what was asked
  back, what is pending, which chats are working on it. A plain "yes"
  answers the pending question without a model call; "yes, but only the
  first one" goes to the model with the question in view.
- **A word count as understanding.** The same repair sent phrases of four
  words or fewer to "I didn't catch that" and longer ones to a chat. The
  planner has the context; it decides. When the model gives no usable plan
  at all, the honest answer is that something went wrong on Labee's side,
  not a chat about whatever was said.
- **A question in the wrong slot.** The model put its confirmation in
  `confirm` with no `actions`, so a yes had nothing to do. A confirmation
  is a proposal with the actions attached; one without them is sent back
  once for the actions, and if it still has none it is spoken as the
  question it is. After a confirmed action, what is spoken is what was
  done ("Step 1 done. Next, step 2: …"), never the plan's own words.
