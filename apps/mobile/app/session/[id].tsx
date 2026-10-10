// The session screen: transcript + composer, hold-to-talk, read-aloud, voice
// overlay, a side pane (activity/diff) on wide screens, and — when the
// session tracks a protocol run — the step bar above the transcript with a
// Note button that files on the current step (run-design §5.2).
//
// Reached by deep link too: labee://session/<id>?voice=1 opens Voice mode;
// labee://session/new?voice=1 makes a session first; `listen=1` also starts
// listening at once (the Action Button or Control Center path, via
// labee://voice).
//
// Lab mode: while a run is open, short spoken commands ("done", "how much
// TSS", "timer 10 minutes", "note …") act on the run here and are answered
// aloud by the phone, with no agent turn and no app name to say.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { parseRunCommand, parseVoiceCommand, RUN_COMMAND_HINTS, type AskUserAnswer, type RunCommand, type TranscriptMessage } from "@labee/session-core";
import { createSession, getDiff } from "~/api/sessions";
import { afterAdvance, durationWords, peekLine, stepAmountsLine, stepLine, timeLeftLine, whereLine } from "~/runs/voice";
import { useRun } from "~/hooks/useRun";
import { useSessionStream } from "~/hooks/useSessionStream";
import { usePushToTalk } from "~/hooks/usePushToTalk";
import { useReadAloud } from "~/hooks/useReadAloud";
import { useWide } from "~/hooks/useLayout";
import { useApp } from "~/state/AppContext";
import { getPref } from "~/storage";
import { Chip } from "~/ui/Chip";
import { Composer } from "~/ui/Composer";
import { MessageBubble } from "~/ui/MessageBubble";
import { Screen } from "~/ui/Screen";
import { StatusDot } from "~/ui/StatusDot";
import { StepBar } from "~/ui/StepBar";
import { useTheme } from "~/ui/theme";
import { VoiceOverlay } from "~/ui/VoiceOverlay";

export default function SessionScreen() {
  const t = useTheme();
  const wide = useWide();
  const router = useRouter();
  // `skill` arrives when the session was opened from a protocol: attach it to
  // every turn here, so the answers are drawn from those steps. `voice=1`
  // opens Voice mode at once (Siri's "Talk to Labee", a notification's
  // "Read in Labee").
  const { id: rawId, skill, voice, listen } = useLocalSearchParams<{ id: string; skill?: string; voice?: string; listen?: string }>();
  const { target } = useApp();
  const [id, setId] = useState<string | undefined>(rawId === "new" ? undefined : rawId);
  useEffect(() => {
    if (rawId !== "new") {
      setId(rawId);
      return;
    }
    let cancelled = false;
    void createSession(target).then((r) => {
      if (cancelled) return;
      router.replace(`/session/${r.session.id}${voice ? `?voice=1${listen ? "&listen=1" : ""}` : ""}`);
    });
    return () => {
      cancelled = true;
    };
  }, [rawId, target, router, voice, listen]);

  const stream = useSessionStream(target, id);
  const ptt = usePushToTalk(target);
  const readAloud = useReadAloud(false);
  const [voiceOpen, setVoiceOpen] = useState(voice === "1");
  const [heard, setHeard] = useState<string | null>(null);
  const [saying, setSaying] = useState("");
  const [answering, setAnswering] = useState(false);
  const [noteMode, setNoteMode] = useState(false);
  const [diff, setDiff] = useState<{ files: { path: string; status: string }[]; diff: string; isRepo: boolean } | null>(null);
  const [pane, setPane] = useState<"activity" | "diff">("activity");
  const listRef = useRef<FlatList<TranscriptMessage>>(null);

  const { state, summary } = stream;
  const run = useRun(target, summary?.run?.id ?? null);

  useEffect(() => {
    void getPref("labee:readAloud").then((v) => {
      if (v === "1" || voice === "1") readAloud.setEnabled(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Read-aloud: feed live deltas, flush at turn end. Voice overlay shows the
  // text being spoken as a running caption.
  useEffect(() => {
    const offDelta = stream.onDelta((_turn, text) => {
      readAloud.feed(text);
      setSaying((s) => (s + text).slice(-400));
    });
    const offEnd = stream.onTurnEnd(() => readAloud.flush());
    return () => {
      offDelta();
      offEnd();
    };
  }, [stream.onDelta, stream.onTurnEnd, readAloud.feed, readAloud.flush]);

  // A run line in the transcript means the run changed somewhere (Siri, the
  // Mac): pull the fresh state so the step bar agrees with the chat.
  const lastSystem = useMemo(() => [...state.messages].reverse().find((m) => m.role === "system")?.id, [state.messages]);
  useEffect(() => {
    if (lastSystem) void run.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSystem]);

  const live = state.streaming;
  const pendingQuestion = useMemo(() => [...state.messages].reverse().find((m) => m.question && !m.question.answers), [state.messages]);

  const sendText = useCallback(
    async (text: string, voiceTurn = false) => {
      readAloud.stop();
      setSaying("");
      await stream
        .send({ text, voice: voiceTurn, device: "iPhone", ...(skill ? { skillSlugs: [skill] } : {}) })
        .catch((e) => setHeard(`Error: ${e instanceof Error ? e.message : String(e)}`));
    },
    [stream.send, readAloud.stop, skill],
  );

  /** Speak a Lab mode answer and show it as the caption. */
  const reply = useCallback(
    (line: string) => {
      readAloud.stop();
      setSaying(line);
      readAloud.say(line);
    },
    [readAloud.stop, readAloud.say],
  );

  const runCommand = useCallback(
    async (cmd: RunCommand): Promise<string> => {
      const failed = "I couldn't reach the run. Try again.";
      // Answers about where things stand use a fresh copy: Siri, the Mac or
      // the lock screen may have moved the run since the last poll.
      const fresh = (await run.refresh()) ?? run.data;
      if (!fresh) return failed;
      switch (cmd.kind) {
        case "advance": {
          const p = await run.advance();
          return p ? afterAdvance(p) : failed;
        }
        case "back": {
          const p = await run.back();
          return p ? `Back. ${stepLine(p)}` : failed;
        }
        case "skip": {
          const p = await run.skip();
          return p ? `Skipped. ${afterAdvance(p)}` : failed;
        }
        case "where":
          return whereLine(fresh);
        case "read":
          return stepLine(fresh);
        case "peek":
          return peekLine(fresh);
        case "amount": {
          if (!cmd.material) return stepAmountsLine(fresh);
          const a = await run.howMuch(cmd.material).catch(() => null);
          return a ? a.say || a.text : failed;
        }
        case "timer": {
          if (!cmd.seconds && !fresh.view.current?.timer) return "This step has no timer of its own. Say timer and a length, like timer 10 minutes.";
          const t = await run.startTimer(cmd.seconds ? { seconds: cmd.seconds, label: durationWords(cmd.seconds) } : {});
          return t ? `Timer set for ${durationWords(t.seconds)}.` : failed;
        }
        case "cancel_timer": {
          const t = fresh.view.timers.find((x) => x.state === "running");
          if (!t) return "No timer is running.";
          return (await run.cancelTimer(t.id)) ? "Timer cancelled." : failed;
        }
        case "time_left":
          return timeLeftLine(fresh);
        case "note": {
          if (!cmd.text) {
            setNoteMode(true);
            return `Go ahead. Tap the mic and say the note for step ${fresh.run.current}.`;
          }
          const p = await run.note(cmd.text);
          return p ? `Noted on step ${p.run.current}.` : failed;
        }
        case "pause": {
          const p = await run.pause();
          return p ? "Paused. Say resume when you're back." : failed;
        }
        case "resume": {
          const p = await run.resume();
          return p ? `Resumed. ${stepLine(p)}` : failed;
        }
        case "finish": {
          const p = await run.finish();
          return p ? "Run finished. The write-up will appear in this chat." : failed;
        }
      }
    },
    [run],
  );

  const handleTranscript = useCallback(
    async (text: string) => {
      if (!text) return;
      setHeard(text);
      if (noteMode && run.data) {
        setNoteMode(false);
        const p = await run.note(text);
        reply(p ? `Noted on step ${p.run.current}.` : "I couldn't save the note. Try again.");
        return;
      }
      const runOpen = run.data && (run.data.run.status === "running" || run.data.run.status === "paused");
      const rc = runOpen ? parseRunCommand(text) : null;
      if (rc) {
        reply(await runCommand(rc));
        return;
      }
      const cmd = parseVoiceCommand(text);
      switch (cmd.kind) {
        case "stop":
          readAloud.stop();
          await stream.cancel();
          return;
        case "repeat": {
          const last = [...state.messages].reverse().find((m) => m.role === "assistant" && m.content);
          if (last) readAloud.say(last.content.slice(0, 600));
          return;
        }
        case "approve":
        case "reject": {
          if (pendingQuestion?.question) {
            const q = pendingQuestion.question.questions[0];
            const opt = q?.options[cmd.kind === "approve" ? 0 : Math.min(1, (q.options.length || 1) - 1)];
            if (q && opt) await stream.answer([{ question: q.question, answer: opt.label }], true);
            return;
          }
          await sendText(text, true);
          return;
        }
        case "new_session":
          await sendText(text, true);
          return;
        case "send":
          if (pendingQuestion) return; // the question card consumes the transcript via voiceText
          await sendText(cmd.text, true);
      }
    },
    [noteMode, run, pendingQuestion, readAloud, sendText, state.messages, stream, reply, runCommand],
  );

  const onPttStart = useCallback(() => {
    readAloud.stop();
    void ptt.start();
  }, [ptt.start, readAloud.stop]);
  const onPttStop = useCallback(async () => {
    const text = await ptt.stop();
    await handleTranscript(text);
  }, [ptt.stop, handleTranscript]);

  // Voice mode is tap-to-talk: one tap listens until you pause; a tap while
  // listening ends it early. Nothing to hold, so it works with gloves on.
  const onVoiceTap = useCallback(async () => {
    if (ptt.state === "recording") {
      await handleTranscript(await ptt.stop());
      return;
    }
    if (ptt.state === "transcribing") return;
    readAloud.stop();
    await handleTranscript(await ptt.listen());
  }, [ptt.state, ptt.stop, ptt.listen, readAloud.stop, handleTranscript]);

  // Opened from the Action Button or Control Center: listen straight away,
  // once the session (and its run, if any) has loaded.
  const autoListened = useRef(false);
  useEffect(() => {
    if (listen !== "1" || autoListened.current || !id || stream.loading) return;
    if (summary?.run && !run.data) return;
    autoListened.current = true;
    void onVoiceTap();
  }, [listen, id, stream.loading, summary?.run, run.data, onVoiceTap]);

  const onAnswer = useCallback(
    async (answers: AskUserAnswer[]) => {
      setAnswering(true);
      try {
        await stream.answer(answers, readAloud.enabled);
      } finally {
        setAnswering(false);
      }
    },
    [stream.answer, readAloud.enabled],
  );

  const lastActivity = useMemo(() => {
    const m = [...state.messages].reverse().find((x) => x.role === "assistant" && x.pending);
    const tool = m?.activity.filter((a) => a.kind === "tool").slice(-1)[0];
    return tool && tool.kind === "tool" ? `${tool.name}${tool.done ? "" : "…"}` : null;
  }, [state.messages]);

  const loadDiff = useCallback(async () => {
    if (!id) return;
    setDiff(await getDiff(target, id).catch(() => null));
  }, [target, id]);
  useEffect(() => {
    if (wide && pane === "diff") void loadDiff();
  }, [wide, pane, loadDiff]);

  const header = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: t.border }}>
      <StatusDot status={summary?.status ?? "idle"} />
      <Text numberOfLines={1} style={{ color: t.muted, fontSize: 12, flex: 1 }} testID="session-status">
        {summary?.status ?? ""}{summary?.costUsd ? ` · $${summary.costUsd.toFixed(2)}` : ""}{stream.connected ? "" : " · reconnecting"}
      </Text>
      {summary?.kind === "siri" ? <Chip label="Siri log" tone="accent" /> : null}
      {summary?.hostOnline === false ? <Chip label="Mac asleep" tone="warn" /> : null}
    </View>
  );

  const transcript = (
    <FlatList
      ref={listRef}
      testID="transcript"
      data={state.messages}
      keyExtractor={(m) => m.id}
      renderItem={({ item }) => (
        <MessageBubble m={item} live={live} onAnswer={item.question && !item.question.answers ? onAnswer : undefined} voiceText={heard} answering={answering} />
      )}
      onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
      contentContainerStyle={{ paddingVertical: 8 }}
      ListEmptyComponent={
        stream.loading ? <Text style={{ color: t.muted, padding: 24 }}>Loading…</Text> : <Text style={{ color: t.muted, padding: 24, textAlign: "center" }}>Say or type something to start.</Text>
      }
    />
  );

  const sidePane = wide ? (
    <View style={{ width: 320, borderLeftWidth: 1, borderLeftColor: t.border }}>
      <View style={{ flexDirection: "row", gap: 12, padding: 12, borderBottomWidth: 1, borderBottomColor: t.border }}>
        {(["activity", "diff"] as const).map((p) => (
          <Pressable key={p} onPress={() => setPane(p)}>
            <Text style={{ color: pane === p ? t.accent : t.muted, fontWeight: "600" }}>{p === "activity" ? "Activity" : "Diff"}</Text>
          </Pressable>
        ))}
      </View>
      <ScrollView contentContainerStyle={{ padding: 12 }}>
        {pane === "activity" ? (
          state.messages
            .filter((m) => m.role === "assistant")
            .flatMap((m) => m.activity.filter((a) => a.kind === "tool"))
            .map((a, i) =>
              a.kind === "tool" ? (
                <Text key={`${a.id}-${i}`} style={{ color: t.muted, fontSize: 12, marginBottom: 4 }}>
                  {a.done ? "✓" : "…"} {a.name}
                </Text>
              ) : null,
            )
        ) : diff ? (
          <>
            {diff.files.map((f) => (
              <Text key={f.path} style={{ color: t.text, fontSize: 12 }}>
                {f.status} {f.path}
              </Text>
            ))}
            <Text selectable style={{ color: t.muted, fontFamily: t.mono, fontSize: 11, marginTop: 8 }}>
              {diff.isRepo ? diff.diff || "No changes." : "Not a git repository."}
            </Text>
          </>
        ) : (
          <Text style={{ color: t.muted }}>Loading diff…</Text>
        )}
      </ScrollView>
    </View>
  ) : null;

  return (
    <Screen>
      <Stack.Screen options={{ title: summary?.title ?? "Session" }} />
      {header}
      {summary?.run ? <StepBar run={run} /> : null}
      {stream.error ? <Text style={{ color: t.danger, padding: 12 }}>{stream.error}</Text> : null}
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }} keyboardVerticalOffset={88}>
        <View style={{ flex: 1, flexDirection: "row" }}>
          <View style={{ flex: 1 }}>{transcript}</View>
          {sidePane}
        </View>
        {summary?.run && run.data?.run.status === "running" ? (
          <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 12, paddingTop: 6, alignItems: "center" }}>
            <Pressable
              testID="note-toggle"
              onPress={() => setNoteMode((v) => !v)}
              style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: noteMode ? t.accent : t.border, backgroundColor: noteMode ? t.card : "transparent" }}
            >
              <Text style={{ color: noteMode ? t.accent : t.muted, fontSize: 12, fontWeight: "600" }}>📝 Note{noteMode ? ` on step ${run.data.run.current} — hold the mic or type` : ""}</Text>
            </Pressable>
          </View>
        ) : null}
        <Composer
          onSend={(text) => {
            if (noteMode && run.data) {
              setNoteMode(false);
              void run.note(text);
              return;
            }
            void sendText(text, false);
          }}
          onStop={() => {
            readAloud.stop();
            void stream.cancel();
          }}
          streaming={live}
          ptt={ptt.state}
          onPttStart={onPttStart}
          onPttStop={() => void onPttStop()}
          onOpenVoice={() => {
            readAloud.setEnabled(true);
            setVoiceOpen(true);
          }}
          readAloud={readAloud.enabled}
          onToggleReadAloud={() => {
            if (readAloud.enabled) readAloud.stop();
            readAloud.setEnabled(!readAloud.enabled);
          }}
          queued={stream.queue.length}
          disabled={!id}
          error={ptt.error}
        />
      </KeyboardAvoidingView>
      <VoiceOverlay
        visible={voiceOpen}
        onClose={() => {
          readAloud.stop();
          setVoiceOpen(false);
        }}
        ptt={ptt.state}
        seconds={ptt.seconds}
        onTap={() => void onVoiceTap()}
        step={
          run.data && (run.data.run.status === "running" || run.data.run.status === "paused") && run.data.view.current
            ? `Step ${run.data.view.current.n} of ${run.data.run.snapshot.steps.length}: ${run.data.view.current.text.split("\n")[0]}`
            : null
        }
        hints={run.data && (run.data.run.status === "running" || run.data.run.status === "paused") ? (noteMode ? ["say the note"] : RUN_COMMAND_HINTS) : null}
        heard={heard}
        saying={saying}
        activity={lastActivity}
        speaking={readAloud.speaking}
        streaming={live}
        onInterrupt={() => readAloud.stop()}
        error={ptt.error}
      />
    </Screen>
  );
}
