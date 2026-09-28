# App Review — reply and Notes for Labee iOS 1.0

Apple's Guideline 2.1 "Information Needed" request (2026-09-22) asks for six
items, both as a reply in App Store Connect and in the Notes field under
App Review Information. Items 2–6 are below, ready to paste. Item 1 is the
screen recording, which has to be captured on a physical iPhone — see the
shot list at the end.

Demo account credentials are NOT in this file. Add them in App Store Connect
only, in the App Review Information → Sign-in required fields and in the
Notes, when you paste this.

---

## 2. Purpose and audience

Labee is a lab notebook and assistant for bench scientists. A researcher
keeps their protocols — step-by-step experimental procedures such as a PCR
setup, a plasmid miniprep, or a Gibson assembly — as documents in Labee,
organised by category and searchable by meaning rather than exact words.
They can then chat with an AI assistant that has those protocols in front of
it: ask how to adapt a step, troubleshoot a failed reaction, or plan the
next experiment, and get an answer grounded in their own written procedures.

The problem it solves: bench protocols live in scattered notebooks, PDFs and
chat threads, and generic AI assistants know nothing about a lab's specific
methods. Labee keeps the methods in one place and makes the assistant work
from them.

Target audience: research scientists and graduate students in molecular
biology and adjacent wet-lab fields, working individually or in small labs.

The iPhone app is the companion to the Labee desktop app (macOS). The
desktop app holds the protocols and runs the assistant on the scientist's
own computer; the phone lets them read their protocols, continue their
chats and start new ones from the bench, away from the computer.

## 3. Setup and access

1. Install and open the app. Leave the Server field at its default
   (https://labee.online), enter the demo account's email and password under
   Sign-in required, and tap "Sign in".
2. The app connects to the demo account's linked Mac automatically. The
   Sessions tab lists three existing conversations; the Protocols tab lists
   twelve bench protocols. (The Runs tab is for long-running multi-step
   analyses and is empty on the demo account.)
3. Open any conversation and send a message — for example "Summarise the Gibson
   assembly protocol in three steps" — to see the assistant reply using the
   protocols. Replies take about 20–40 seconds.
4. Tap "New" to start a fresh conversation. Open any protocol to read it.
5. Accounts are created on our website (labee.online) or by "Sign in with
   Google", which creates an account on first use; the app has no separate
   registration form. Account deletion is in the app: Settings → Delete
   account, which permanently erases the account and its data. Please do not
   delete the demo account itself — the recording shows deletion on a
   throwaway account made for the purpose.

No sample files are needed; the demo account is pre-populated.

## 4. External services

- labee.online — our own hosted service (AWS). Accounts, sign-in, and the
  relay that connects the phone to the user's Mac.
- Google Sign-In — optional alternative to email sign-in.
- Anthropic Claude and OpenAI GPT — the AI models the assistant is built
  on. Inference runs on the user's own Mac using their own account with
  those providers, or through our service on a metered plan.
- Stripe — payment processing for plans bought on our website. There are no
  in-app purchases; nothing is sold inside the iOS app.
- Expo (EAS) — build and update tooling; Expo push notifications for
  "the assistant needs your input" alerts.

## 5. Regional differences

None. The app functions identically in all regions. The interface is
English only at this time.

## 6. Regulated industry / third-party material

Labee is not in a regulated industry and handles no medical, financial or
personal health data. The twelve starter protocols included with the app
are original, written by us for general molecular-biology teaching use; they
are not reproduced from any publisher. All other content is created by the
user.

---

## Item 1 — screen recording shot list (physical iPhone, latest iOS)

Record in one continuous take with iOS Screen Recording (Control Centre).
Start from the Home screen. Total ~3–4 minutes.

1. Launch the app from the Home screen.
2. Sign in with the demo account (email + password). Show the Chats list load.
3. Open an existing conversation; scroll a little to show prior messages.
4. Send a message ("Summarise the Gibson assembly protocol in three steps")
   and wait for the reply to stream in.
5. Back to Sessions; tap New; send one short message; show the reply.
6. Protocols tab: scroll the list, open one, scroll its content.
7. Settings: show the account section, and Devices (the linked Mac). Sign out.
8. Deletion, on a THROWAWAY account, never the demo. Beforehand, create one
   at labee.online in Safari (or use a spare Google account). In the app:
   sign out, sign in as the throwaway, then Settings → Delete account →
   confirm. Show the app returning to the sign-in screen. If you use Google
   for this, the sign-in itself is the account-creation step Apple asks to
   see, so keep it in the recording.
9. Stop recording.

Then: upload the video with the reply in App Store Connect (the reply form
accepts attachments), and paste items 2–6 into both the reply and the Notes.
