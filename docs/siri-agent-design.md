# The Siri agent: Labee from the lock screen

*Design, 2026-10-10. Follows `siri-design.md` (phrases, the Siri session,
notifications) and `protocol-run-design.md` (runs). It replaces §3.3 of the
Siri design, where the Siri session is a switchboard that never runs a
turn, with a Siri session that is an agent.*

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
that carries text is one turn in it. It has tools over all of Labee: the
chats, the runs, the protocols, the phone's own notifications. It answers
in a sentence Siri can read within Siri's time limit, or it starts work
somewhere else and makes sure the result comes back to the person's ear.

Three rules give it its shape.

1. **One voice.** Whatever was said, the Siri agent replies. It may delegate
   the work to another chat, but it is the one that reports back, in spoken
   length, naming where the work is.
2. **Act, don't retrieve.** "Stop the runs" pauses runs. "How much TSS"
   reads the run. "Compare the two transfection protocols" starts a chat.
   The tools decide what is a question and what is a command; the agent
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
archived (as today). New: it runs turns.

**Where it runs.** Where the person's agent runs: on the selected Mac
through the Device Link, else on the box with the provided tier. The box
owns the runs either way and the control tools reach it, so the agent sees
the same state from either place.

**The model and the budget.** Each turn runs with a fast model, low effort,
a system prompt of about a page, and a hard budget: **12 s of wall clock
and at most 6 tool calls**. The turn is started by `POST /api/siri/say` and
the route waits for either the turn's first final text or the budget, then
answers Siri:

```
POST /api/siri/say   { text, device: "Siri" }
  → { status: "answered", spoken, siriTurnId }
  → { status: "working",  spoken: "On it. I'll tell you when it's done.", siriTurnId }
  → { status: "confirm",  spoken: "Pause both runs?", confirmId }
```

`answered` is spoken by Siri and the turn is over. `working` means the agent
delegated or ran out of budget; Siri speaks the holding line and the turn
goes on in the background, reporting through §5. `confirm` is for the few
actions that should not happen on a misheard word (§6); the intent uses
`requestConfirmation`, and a yes posts `{ confirmId, yes: true }` to the
same route.

**The prompt.** Terse, spoken, in the person's words. It carries: the time,
the runs in progress with their current step and timers, the last ten
chats with one line each, the person's protocol names, and the rules of
§1. It says what the tools are for, when to answer and when to delegate,
and that a delegated job must be named ("Started 'compare transfections'").
It never lists options as a menu; Siri reads them badly.

**The tools: an MCP server called `labee`.** Served by the Labee server
itself at `/api/mcp/labee` as a Streamable HTTP MCP server, the way the
protocols server is, with a token minted per account for the turn. It is
attached only to turns of `kind: "siri"` sessions. The tools are thin
wrappers over routes that exist today; nothing new happens in them, which
is what keeps the agent honest.

| Tool | Does | Backed by |
|---|---|---|
| `chats.list` | the recent chats: id, title, status, last line, pending question | `GET /api/sessions` |
| `chats.read(id, n)` | the last n messages of a chat | `GET /api/sessions/:id` |
| `chats.send(id, text)` | continue a chat; returns `{ queued }` | `POST /api/sessions/:id/turns` with `origin: "siri"` |
| `chats.new(title, text)` | start a chat with a first message | `POST /api/sessions` then turns |
| `chats.answer(id, spoken)` | answer the question a chat is waiting on | `POST /api/sessions/:id/answer { spoken }` |
| `chats.stop(id)` | stop a running turn | `POST /api/sessions/:id/cancel` |
| `runs.list` | runs in progress: protocol, step, timers | `GET /api/runs` |
| `runs.get(id)` | the run: current step, amounts, notes, timers | `GET /api/runs/:id` |
| `runs.act(id, action, …)` | done, back, skip, note, timer, pause, resume, finish | `POST /api/runs/:id/<action>` |
| `runs.amount(id, material)` | the tiered amount answer | `POST /api/runs/:id/amount` |
| `runs.start(protocolSlug, scale?)` | start a run | `POST /api/runs` |
| `protocols.search(q)` / `protocols.get(slug)` | the person's protocol library | the artifact index |
| `ask.quick(q)` | the retrieval answer, for a pure protocol question | `POST /api/ask/quick` |
| `say(text)` | the final spoken answer; ends the turn early | (the route reads it) |

`say` is how the agent beats the budget: it can call a tool, then `say`,
and the route answers Siri the moment `say` arrives rather than at the end
of the turn. The rest of the turn (a `chats.new`, a log line) finishes in
the background.

**What the Siri session's transcript holds.** It stays the audit trail,
and becomes readable: the person's phrase as a user message, the agent's
spoken reply as an assistant message, tool calls folded away as today, and
one system line per return (§5). "Open the Siri chat" shows a conversation
rather than a log.

## 4. The two lanes

```
phrase ──► /api/siri/say ──► Siri agent turn (12 s, 6 tools)
                               │
            ┌──────────────────┴──────────────────┐
            │ say() within budget                 │ delegated, or over budget
            ▼                                     ▼
     Siri speaks the answer           Siri: "On it. I'll tell you."
     (runs, amounts, status,          chats.send / chats.new with origin: siri
      pause, stop, quick facts)                   │
                                                  ▼
                                    that chat's turn runs (minutes)
                                                  │
                                      turn_ended / question_asked
                                                  ▼
                                    delivery (§5): Siri line + announced push
                                       + unread for "Any news from Labee?"
```

The fast lane covers everything that is a read or a one-step action: that
is most of a bench day. The slow lane is for the agent proper.

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
   Siri agent makes it. The box runs one more short Siri-agent turn with
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

The Siri agent can act. Misheard words must not cost a run.

- **Free:** every read, `runs.act` for done/back/note/timer/pause/resume,
  `chats.send`, `chats.new`, `chats.answer`, `chats.stop`.
- **Confirmed** (`status: "confirm"`, Siri asks "Finish the TSS run?"):
  `runs.act finish`, `runs.start` when a run of that protocol is already
  going, and pausing or stopping more than one thing at once.
- **Never from Siri:** abandoning a run, deleting a chat, anything
  billing. The tools do not exist; the agent says to open the app.

Every action the agent takes is a system line in the chat or run it
touched, with `device: "Siri"`, as run events are today.

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
> *(Siri agent: `runs.list` → two running; two-at-once → confirm)*
> Siri: "Pause both runs, TSS and PEI transfection?"
> "Yes."
> Siri: "Paused. TSS is at step 4 with a timer running; I left the timer.
> PEI is at step 1. Say resume when you're back."

> "Ask Lab Helper what are PCR stats."
> *(`protocols.search("PCR stats")` → nothing; `ask.quick` → NEEDS_AGENT;
> this needs a real answer → `chats.new("PCR statistics", …)` → `say`)*
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

- **Siri session runs turns.** `sessions.runner` already runs turns in any
  session; the `siri` kind stops being excluded. Its turns get the Siri
  system prompt, `mcpServers: ["labee"]`, fast model, low effort, the
  budget, and `device: "Siri"`.
- **`POST /api/siri/say`** replaces `/api/siri/route` and `/api/siri/send`
  for the Say intent; `route` stays for Answer (pending question lookup)
  and for StartRun's resume check. The route starts the turn, subscribes to
  its events, and resolves on the first `say` tool call, a final text, or
  the budget.
- **The `labee` MCP server.** `services/labeeMcp.ts`, a Streamable HTTP
  server mounted at `/api/mcp/labee`, token per account minted for the turn
  (as `protocolsMcp.ts` mints the protocols token), tools as in §3 calling
  the route handlers' service functions directly. Attached by
  `turnBuilder` when the session is `kind: "siri"`.
- **Origin on turns.** `TurnRequest.origin?: { kind: "siri"; siriTurnId }`
  in session-core; carried on `turn_started`; read on `turn_ended` and
  `question_asked` by the delivery code.
- **Delivery.** `services/siri/delivery.ts`: on `turn_ended` /
  `question_asked` of a Siri-origin turn, write the Siri line, run the
  summary turn, push. On the box this runs in `handleMirror` for Mac-held
  chats and in the runner's listener for box-held ones.
- **Unread.** `GET /api/siri/news` returns unread returns; `POST
  /api/siri/news/read` marks them. The Siri session's system-message meta
  holds the flag; no new table.
- **Intents.** SayToLabee, CatchUp; `.background` and `.alwaysAllowed` on
  every Siri intent; the App Shortcuts list trimmed to eight.

The run-side code, the Lab mode and the notification categories are
unchanged.

## 10. Phases

1. **Return first** (small, this week). Push registration (done). Siri
   lines, announced summaries and unread on Siri-origin turns, using the
   present router to mark origin. The CatchUp intent. `.alwaysAllowed` on
   every Siri intent. Verifiable on the phone with "Ask Labee" then "Any
   news from Labee?".
2. **The Siri agent.** The `labee` MCP server, the bounded turn, `/api/siri/say`,
   the SayToLabee intent, confirmation. The router and the quick-answer
   route become tools rather than entry points.
3. **Siri AI.** App Schemas for the run and chat entities so iOS 27's Siri
   understands "I'm done with this step" without a phrase or an app name.
4. **A Live Activity for the Siri agent**: the last answer on the lock
   screen, with Done and Answer buttons, so a glance replaces a phrase.

## 11. Open questions

- **Cost.** A fast-model turn per phrase, plus one per return for the
  summary. At today's prices that is a fraction of a cent each; the quick
  answer already costs as much. Worth a counter in Settings.
- **Latency on the Mac path.** A phrase travels phone → box → Mac → model →
  back. The quick path today is 2–5 s; the agent adds a tool call or two.
  The 12 s budget leaves room, but a sleeping Mac means the box runs the
  turn itself on the provided tier, and the Anthropic resale clause noted in
  `provided-device-design.md` applies to that.
- **Two phones.** Returns go to every registered phone of the account.
  Unread is per account, so a return read on one phone is read on both.
- **What Siri AI will do with our intents** before phase 3 is still
  unmeasured; the layered test in the plan's execution log applies.
