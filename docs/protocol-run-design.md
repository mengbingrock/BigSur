# Protocol runs — design

Start a run from one protocol, then get through it by talking:
"what's next", "done", "start the timer", "note: OD was 0.35", "how long do I
spin?", "finish". The phone stays in the pocket; the agent stays in the loop.

Status: design only, nothing here is implemented. Written 2026-10-09.
Builds on [siri-design.md](./siri-design.md) (the Siri mechanics: App
Intents, the 30-second rule, entities, notifications) and
[mobile-companion-design.md](./mobile-companion-design.md) (sessions, the
Device Link, the mirror). Read those first; this document only adds what a
run needs.

---

## 1. The moment

A scientist opens a protocol — say *Chemically competent cells (TSS)*, nine
numbered steps, two of them timed, everything after step 4 on ice — and
starts. For the next hour their hands are wet, gloved, or holding a tube.
What they need, in order of how often they need it:

| Need | Said as | Must be |
|---|---|---|
| Where am I, what's next | "What's next?" | Instant, exact words of the protocol, no model in the way |
| Mark progress | "Done." · "Go back." · "Skip this." | One word, undoable |
| Timed steps | "Start the timer." | Counts down on the lock screen and on AirPods, survives the app being killed |
| Record a deviation | "Note: OD was 0.35, harvested early." | Lands on the right step, visible to the agent |
| Ask about *this* step | "Why on ice?" · "Can I use 2500 rpm?" | Answered against the protocol and the run so far |
| Finish | "Finish the run." | A write-up appears: what was done, when, what deviated |

Today the app has one move: "Ask about this", which opens a chat with the
protocol attached (`apps/mobile/app/protocol/[slug].tsx`). Everything else is
the model re-reading the protocol every turn, and nothing records which step
the person is on. A run is that missing record, and the first four rows above
must work **without a model call** and **while the Mac is asleep**.

**Goals**

1. A run is started from a protocol in one phrase, and progressed with
   one-word phrases, each answered in under two seconds.
2. The agent knows the run: current step, what was done when, notes,
   timers. Questions are answered in that context.
3. The run works at the bench with the Mac asleep, for everything that does
   not need the agent.
4. Finishing a run leaves a document the person can paste into a lab book.

**Non-goals**

- A general notebook (dropped earlier; notes here belong to a step of a run).
- Editing protocols from the phone.
- Multi-person runs, instrument integration, barcode scanning.

---

## 2. What a run is

A run is **a chat session bound to one protocol, with a small structured
state next to the transcript**. The transcript stays the conversation; the
state is what Siri and the lock screen read in under a second.

```
protocol_runs
  id             text pk     "run_…"
  email          text
  session_id     text        the chat it lives in (on the host)
  protocol_slug  text
  protocol_name  text
  steps          json        frozen snapshot, see 2.1
  current        integer     1-based index of the step in progress
  status         text        "running" | "paused" | "done" | "abandoned"
  started_at, updated_at, finished_at

protocol_run_events
  run_id, seq (pk together), ts, type, data
  types: step_started · step_done · step_skipped · step_reopened
         note · timer_started · timer_done · timer_cancelled
         paused · resumed · finished · abandoned
```

Every change is an event; `current` and `status` are derived and cached.
"Go back" is `step_reopened`, not a delete, so the record of what happened is
never rewritten.

### 2.1 Steps: frozen at start

Protocols are markdown with a numbered list under `## Procedure` (or
`## Steps`, `## Method`). At start the host parses that list once:

```json
{ "n": 5, "text": "Spin 10 min at 3000 rpm, 4 C.",
  "say": "Spin ten minutes at three thousand rpm, four degrees.",
  "timer": { "seconds": 600, "label": "Spin" },
  "temp": "4 °C" }
```

- `text` is the protocol's words, verbatim. Siri reads `say`, a spoken form
  with units expanded, produced by a regex pass; a model is not needed for
  this and must not be in the way.
- `timer` is detected from durations in the text ("10 min", "2 h", "30 s");
  a step can have none or one. Ranges ("10–15 min") take the lower bound and
  Siri says the range.
- Sub-bullets and the step's notes paragraph travel with the step so "why?"
  has the author's own reason first.
- `amounts` are every quantity in the step, with what it applies to:
  `[{ "qty": "100", "unit": "µL", "of": "aliquot" }, { "qty": "10", "unit": "%", "of": "original culture volume", "ratio": true }]`.
  The `## Materials` section is parsed the same way into the run's
  `materials` list ("TSS buffer, chilled at 4 °C", "50 ml falcon tubes").
  Both are text matches, not interpretation: a quantity is only ever the
  protocol's own number, and a step with no number for something has none.
- The snapshot is **frozen**: editing the protocol on the Mac mid-run does
  not renumber the steps under the person. The run records the protocol's
  content hash; the write-up says if the protocol changed during the run.

A protocol with no numbered list gets one step per paragraph of the
procedure section, and the start confirmation says "nine steps" so an odd
count is noticed. If the structure is poor, the agent can be asked to
restructure the protocol *before* starting; the run never guesses.

### 2.2 Where the state lives

Sessions live on the host; the box mirrors them for reading. Run state goes
the other way: the **box owns `protocol_runs`**, and the host receives it.

The reason is the bench. "Done", "what's next" and "start the timer" happen
dozens of times in an hour with the Mac asleep at the desk, and each must
succeed. They are deterministic — no model, no files — so the box can answer
them from the frozen snapshot. Only three things need the host:

| Needs the host | Why |
|---|---|
| Starting a run | The protocol text is on the host (for a Mac-hosted account). |
| Questions beyond the protocol's text | The agent. |
| The write-up | The agent, writing into the deck. |

When the host is connected, every run event is pushed down the Device Link
as a `run` frame and the host appends a matching **system line** to the
session transcript ("✓ Step 5 done · 14:32", "Note on step 4: OD 0.35"), so
the chat reads as the story of the run and the agent sees it as history.
Reconnecting replays the events it missed, in order, by `seq`.

### 2.3 API (box-answered, like billing)

```
POST   /api/runs                      { protocolSlug, sessionId? }   → run      (box asks the host to parse; 503 if offline)
GET    /api/runs/active               the person's running or paused runs
GET    /api/runs/:id                  state + events since ?after=seq
POST   /api/runs/:id/advance          current step done; next step started     → { done: step, next: step | null }
POST   /api/runs/:id/back             reopen the previous step
POST   /api/runs/:id/skip             { reason? }
POST   /api/runs/:id/note             { text, step?: n }
POST   /api/runs/:id/timer            { seconds?, label? }   defaults to the current step's timer
DELETE /api/runs/:id/timer/:timerId
POST   /api/runs/:id/pause  · /resume · /finish · /abandon
```

`advance` on the last step marks the run `done` and returns `next: null`;
the client then offers "Finish", which triggers the write-up (§4.3).

---

## 3. Talking to a run

The phrases below are App Intents (see siri-design §2). Three of them carry
an **entity** parameter, which Apple allows in a phrase, so they are one
breath. The rest carry no free text at all, so they are one breath too. Only
"note" and "ask" need Siri's follow-up question.

| Phrase | Does | Siri says back |
|---|---|---|
| "Start *Chemically competent cells* in Labee" | Through the Siri router (siri-design §3.3): a paused or running run of that protocol → resumes it; an existing chat with that protocol attached → the run starts in it; otherwise a new session. Step 1 started. | "Started. Nine steps, two timed. Step one: grow a five-millilitre seed culture…" / "You have a paused run of this from Tuesday, at step three. Resume it, or start fresh?" |
| "What's next in Labee" · "Labee, current step" | Reads the step in progress (the one being done), then the following one if asked "and then?" | "Step five: spin ten minutes at three thousand rpm, four degrees. There's a ten-minute timer." |
| "Labee, done" · "Next step in Labee" | `advance` | "Done with five. Step six: pour off the supernatant…" |
| "Labee, go back" | `back` | "Back on step five." |
| "Skip this step in Labee" | `skip` (asks "Why?" — optional, say "no reason") | "Skipped six." |
| "Start the Labee timer" | `timer` with the step's duration | "Ten minutes, spin. I'll tell you." |
| "Set a Labee timer for fifteen minutes" | `timer` with a spoken duration (duration is an Apple-provided parameter type, allowed in phrases) | "Fifteen minutes. I'll tell you." |
| "Labee, step details" | Reads the whole step: text, sub-bullets, the author's note, every amount in it | "Step seven, in full: resuspend in TSS at ten percent of the original culture volume, or three to five percent for more concentrated cells. Vortex gently. Amounts: ten percent of culture volume. From the notes: everything after step four is at four degrees." |
| "How much *TSS* in Labee" · "Labee, how much water" | Amount of a material for the current step (§4.2) | "Step seven: TSS at ten percent of the original culture volume — for your fifty millilitres, five millilitres." |
| "Note in Labee" → "OD was 0.35, harvested early" | `note` on the current step | "Noted on step two." |
| "Ask Labee" → "can I use 2500 rpm?" | siri-design's Ask, with the run as context | One sentence, or "sent to your session" |
| "Pause Labee" · "Resume Labee" | | "Paused at step five." |
| "Finish the Labee run" | `advance`/`finish` + write-up turn | "Finished: nine steps in fifty-two minutes, one note. Writing it up." |
| "Where am I in Labee" | status | "Competent cells, step five of nine, thirty-one minutes in. Timer: four minutes left." |

Protocol names are a `ProtocolEntity` (siri-design §2.4), refreshed on sign-in
and when protocols change, so "Start *Gibson assembly* in Labee" resolves to
the person's own document. Materials are a `MaterialEntity` drawn from the
**active run's** parsed materials and amounts, with synonyms ("TSS", "TSS
buffer"; "water", "ddH2O", "nuclease-free water"), so "how much *TSS*" is
one breath and Siri does not have to transcribe a reagent name as free
text. "Labee, how much" with no material is also allowed: Siri then asks
"Of what?" and takes the name as text, for anything not in the list. With one run active, no phrase needs to name it;
with two (a long incubation in one, a quick prep in another), Siri asks
which, and the lock screen shows both.

**Timers.** The intent schedules a local time-sensitive notification for the
end (survives the app being killed; read aloud on AirPods) and, in phase 3,
starts a Live Activity so the countdown is on the lock screen and in the
Dynamic Island with a **Done** button. The end notification has actions
*Done with step* and *Five more minutes*. Timers are also run events, so the
write-up has their real start and end.

**Mistakes.** "Done" is cheap to say by accident. Every advance is announced
with the new step, so a wrong one is heard at once, and "go back" is one
phrase. Nothing is deleted.

---

## 4. The agent in a run

### 4.1 Context

A turn in a run session gets, in the system prompt:

- the protocol text (as today, via the attached skill), and
- a compact run view: current step, each step's done/skipped time, notes,
  timers, elapsed time. A few hundred tokens.

So "why on ice?" is answered from the author's notes; "I'm 20 minutes over
on step two, is the culture ruined?" is answered knowing step two and its
timing; "what did I note earlier?" needs no tool.

### 4.2 Step details and amounts

"How much water for this step?" is the most common question at the bench,
and the one where a wrong number costs the experiment. It is answered in
three tiers, each tried in order, and **no tier may invent a quantity**.

```
POST /api/runs/:id/amount    { material, step?: n }          box, deterministic
POST /api/ask/quick          { q, runId }                     box, model, run context
→ session turn                                                host, agent
```

**Tier 1 — the protocol's own words (box, no model, under a second).**
Match the material against the current step's `amounts`, then the step's
sub-bullets and note, then `materials`, then any other step that mentions
it. Answer with the protocol's number and where it came from:

- *"Step eight: aliquot one hundred microlitres into the chilled tubes."*
- *"The protocol doesn't give an amount of water in step three. The
  materials list says 'TSS buffer, chilled'. Want me to ask Labee?"* — the
  honest answer when the number is not there, with the escalation offered.

**Scaling.** Many steps give ratios, not amounts ("TSS at 10 % of the
original culture volume"). A run can carry a **scale**: at start, if the
protocol's procedure names a base quantity ("25–50 ml of fresh LB"), Siri
asks once "What volume are you running?" (a duration/number parameter, one
beat; skip with "default"). A tier-1 answer then adds the computed figure
and says that it computed it: *"ten percent of the original culture volume
— for your fifty millilitres, five millilitres."* The protocol's words come
first, the arithmetic second, so a mis-set scale is caught by ear.

**Tier 2 — the model, against the run (box).** Questions the text cannot
settle by matching ("is 0.35 within range?", "how much per tube if I split
it in four?") go to siri-design's `/api/ask/quick` with the run context
(§4.1), under its 7-second budget. The model is instructed to quote the
step it used and to say "the protocol doesn't specify" rather than guess;
a number it computes is labelled as computed.

**Tier 3 — the agent (host).** Anything needing files, the web, or more
than a sentence escalates to the session as in siri-design §3.2, and the
answer comes back as a notification.

The same three tiers back the step bar's "amounts" line in the app (§5.2),
so the phone shows exactly what Siri would say.

### 4.3 The write-up

"Finish" starts one agent turn with a fixed instruction: produce
`Runs/2026-10-09 Chemically competent cells.md` in the deck:

```
# Chemically competent cells (TSS) — 9 Oct 2026, 14:02–14:54
Protocol: chemically-competent-cells-tss (unchanged during the run)

| Step | Started | Done | Notes |
| 1 Grow seed culture | 14:02 | 14:08 | |
| 2 Incubate to OD 0.2–0.5 | 14:08 | 14:31 | OD was 0.35, harvested early |
| …
Timers: step 4 ice 10:00 (ran 10:40) · step 5 spin 10:00 (ran 10:05)
Deviations: step 2 harvested at OD 0.35 (protocol: 0.2–0.5, within range).
```

The table is generated from events (exact), the deviations paragraph by the
model (judgement), and the person can keep talking in the same session to
refine it. The file is an ordinary deck file: visible in the app, editable
on the Mac, attachable to the next chat.

---

## 5. In the app

### 5.1 Starting

The protocol screen gets a second button beside "Ask about this": **Start
run**. It shows the parsed steps as a checklist for a glance ("nine
steps, two timers") and starts the run. If the host is asleep the button
says so instead of failing later.

### 5.2 The run screen

The session screen with a **step bar** pinned above the transcript:

```
┌──────────────────────────────┐
│ ‹ Chats   Competent cells  ⋯ │
│ Step 5 of 9 · 31 min         │
│ ┌──────────────────────────┐ │
│ │ Spin 10 min at 3000 rpm, │ │   ← current step, big, the protocol's words
│ │ 4 °C.                    │ │
│ │ 10 min · 3000 rpm · 4 °C │ │   ← amounts line: every quantity in the step (§4.2)
│ │ ⏱ 04:12 left      [Done] │ │   ← timer when running; Done advances
│ └──────────────────────────┘ │
│ ✓ 4  Stand on ice 10 min · 14:21                                  │
│ 📝 2  OD was 0.35, harvested early                                │
│ Labee: Harvesting at 0.35 is fine; competence drops above 0.5…   │
├──────────────────────────────┤
│ [ Aa ]  ( 🎤 hold )  [ Note ] │   ← Note = hold-to-talk that files on the step
└──────────────────────────────┘
```

Tapping the step bar opens the full checklist: done steps ticked with
times, the current one highlighted, upcoming ones plain; tap any to jump
(recorded as `step_reopened` / `step_skipped`). Swiping on the current step
offers Back and Skip.

### 5.3 Lock screen and AirPods

- Running timer → Live Activity (phase 3) with the step text and a Done
  button that calls the same intent as the phrase.
- Timer end → time-sensitive local notification: read aloud on AirPods,
  actions *Done with step* / *Five more minutes*.
- Agent replies in a run → the normal turn-end push (siri-design §4), so an
  answer to "can I use 2500 rpm?" is announced.

### 5.4 The Runs tab

The **Runs** tab is where runs live. Today it lists research runs; it
becomes the list of everything in progress, in two groups:

```
┌──────────────────────────────┐
│ Runs                         │
│ IN PROGRESS                  │
│ ● Competent cells (TSS)      │   ← protocol run: step 5 of 9 · 31 min · ⏱ 04:12
│   step 5 of 9 · 31 min · ⏱   │
│ ◐ Gibson assembly            │   ← paused
│   paused at step 3 · 2 h ago │
│ RESEARCH                     │
│ ● MoE load balancing study   │   ← research run, as today
│   discover · 14 min          │
│ FINISHED                     │
│   PCR optimisation · Tue     │   ← opens the write-up
└──────────────────────────────┘
```

- A protocol run opens its run screen (§5.2). Its row shows the step
  fraction, elapsed time and a live timer; running runs sort first.
- Finished runs stay under **Finished** for the write-up; a swipe archives.
- Research runs keep their section and screen unchanged.
- The tab badge is the number of runs waiting on the person: a timer that
  has ended, or a step that has been open for much longer than its timer.

The same rows appear in the **Chats** list, since every run is a session,
marked with the step fraction instead of the status dot; tapping either
place opens the same screen.

### 5.5 Naming

"Run" is the word throughout — Runs tab, "Start run", "Finish the run",
`Runs/` folder for write-ups — and research runs are the tab's second
group. Code and API keep `protocol_runs` and `research_runs` as distinct
tables.

---

## 6. Example session

```
You:   Hey Siri, start Chemically competent cells in Labee.
Siri:  Started. Nine steps, two timed. Step one: grow a five-millilitre
       seed culture to saturation, then dilute one to a hundred into
       twenty-five to fifty millilitres of fresh LB.
   …
You:   Labee, done.
Siri:  Done with one. Step two: incubate at thirty to thirty-seven degrees
       until OD six hundred reaches point two to point five. Don't overshoot.
   …  (twenty minutes)
You:   Note in Labee.
Siri:  What's the note?
You:   OD was point three five, harvesting now.
Siri:  Noted on step two.
You:   Labee, done.
Siri:  Done with two. Step three: chill the Eppendorfs on ice and pre-chill
       the TSS.
   …
You:   Labee, done.
Siri:  Done with four. Step five: spin ten minutes at three thousand rpm,
       four degrees. There's a ten-minute timer.
   …
You:   How much TSS in Labee?
Siri:  Step seven: TSS at ten percent of the original culture volume, or
       three to five percent for more concentrated cells. For your fifty
       millilitres, five millilitres.
You:   Labee, how much water?
Siri:  The protocol doesn't give an amount of water in step seven, or in the
       materials. Want me to ask Labee?
You:   No.
You:   Start the Labee timer.
Siri:  Ten minutes, spin. I'll tell you.
You:   Ask Labee.
Siri:  What's your question?
You:   Can I use twenty-five hundred rpm, the centrifuge won't go higher.
Siri:  Yes; spin twelve to thirteen minutes instead to match the force, and
       keep it at four degrees. Anything else?
You:   No.
   …  (AirPods, ten minutes later)
       "Labee: Spin timer done. Step five."   [Done with step] [Five more minutes]
   …
You:   Finish the Labee run.
Siri:  Finished: nine steps in fifty-two minutes, one note, one deviation.
       Writing it up in your session.
```

On the Mac, the session "Chemically competent cells" reads as the run: the
system lines for each step, the note, the agent's answer about the
centrifuge, and the write-up at the end.

---

## 7. Phases

| Phase | Deliverable | Exit condition |
|---|---|---|
| 1 | Step parser (host), `protocol_runs` + events (box), API, `run` frames down the link, transcript system lines, agent run context, Start run button, step bar, Runs tab groups, Note. Timers as local notifications. | A full run from the app on a phone with the Mac asleep after start; the transcript on the Mac tells the story; "Finish" produces the write-up. |
| 2 | Siri: Start (entity phrase), next/done/back/skip/timer/pause/resume/finish/where-am-I; Note and Ask via siri-design; timer-end notification actions. | The §6 session, on a device, without touching the phone after the first phrase. |
| 3 | Live Activity with Done; Control Center "Done" control; quick answers from the frozen steps; chats-list progress. | Timer and current step on the lock screen; Done from there. |
| 4 | Two concurrent runs; protocol-change detection in the write-up; Watch (needs a Watch app). | — |

Phase 1 is independent of Siri and depends only on siri-design's phase 1
(notification categories) for the timer-end actions.

---

## 8. Risks and open questions

- **Step parsing.** Numbered lists are the common case in the seeded
  protocols and in what people import, but not universal. The start
  confirmation ("nine steps") and the checklist preview are the guard;
  restructuring with the agent beforehand is the fix. No silent guessing.
- **Numbers.** A misheard "fifteen" for "fifty" in the scale, or a
  misread "ul" for "ml" in a badly formatted protocol, is worse than no
  answer. Hence: amounts are text matches of the protocol, never inferred;
  Siri reads the protocol's words before any computed figure; the scale is
  read back when set and shown in the step bar; units are parsed from a
  fixed list (µL/ul, mL, L, mg, g, µg, ng, mM, M, %, rpm, ×g, °C, min, h, s)
  and anything else is left as text, not a quantity.
- **"Done" by accident, and "next" ambiguity.** Every advance announces the
  new step; "go back" is one phrase; "what's next" never advances. Siri's
  phrase matching needs the app name, which also prevents "done" from
  triggering during ordinary Siri use.
- **Timers if the phone is off the person.** Local notifications fire
  regardless of the app; AirPods announce them; the Mac does not. A Mac-side
  banner for timer end is a small addition once `run` frames exist.
- **Box ownership of run state** is the second thing after billing that the
  host receives rather than owns. It is a deliberate exception for a
  deterministic, bench-critical record; it must not become the pattern for
  session content.
- **Decided (2026-10-09):** where a run's session comes from is the Siri
  router's call (siri-design §3.3): resume a paused run of the same
  protocol, continue in an existing chat that has the protocol attached,
  else create a new session. From the app, "Start run" on a protocol
  screen does the same lookup and offers the same choice.
- **Decided (2026-10-09):** the write-up is also posted as the session's
  final assistant message, so it appears on the phone without opening the
  deck.
