// The session screen: transcript + composer, hold-to-talk, read-aloud, voice
// overlay, and a side pane (activity/diff) on wide screens.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Stack, useLocalSearchParams } from "expo-router";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { parseVoiceCommand, type AskUserAnswer, type TranscriptMessage } from "@labee/session-core";
import { getDiff } from "~/api/sessions";
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
import { useTheme } from "~/ui/theme";
import { VoiceOverlay } from "~/ui/VoiceOverlay";

export default function SessionScreen() {
  const t = useTheme();
  const wide = useWide();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { target } = useApp();
  const stream = useSessionStream(target, id);
  const ptt = usePushToTalk(target);
  const readAloud = useReadAloud(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [heard, setHeard] = useState<string | null>(null);
  const [saying, setSaying] = useState("");
  const [answering, setAnswering] = useState(false);
  const [diff, setDiff] = useState<{ files: { path: string; status: string }[]; diff: string; isRepo: boolean } | null>(null);
  const [pane, setPane] = useState<"activity" | "diff">("activity");
  const listRef = useRef<FlatList<TranscriptMessage>>(null);

  useEffect(() => {
    void getPref("labee:readAloud").then((v) => {
      if (v === "1") readAloud.setEnabled(true);
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

  const { state, summary } = stream;
  const live = state.streaming;
  const pendingQuestion = useMemo(() => [...state.messages].reverse().find((m) => m.question && !m.question.answers), [state.messages]);

  const sendText = useCallback(
    async (text: string, voice = false) => {
      readAloud.stop();
      setSaying("");
      await stream.send({ text, voice }).catch((e) => setHeard(`Error: ${e instanceof Error ? e.message : String(e)}`));
    },
    [stream.send, readAloud.stop],
  );

  const handleTranscript = useCallback(
    async (text: string) => {
      if (!text) return;
      setHeard(text);
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
    [pendingQuestion, readAloud, sendText, state.messages, stream],
  );

  const onPttStart = useCallback(() => {
    readAloud.stop();
    void ptt.start();
  }, [ptt.start, readAloud.stop]);
  const onPttStop = useCallback(async () => {
    const text = await ptt.stop();
    await handleTranscript(text);
  }, [ptt.stop, handleTranscript]);

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
      {stream.error ? <Text style={{ color: t.danger, padding: 12 }}>{stream.error}</Text> : null}
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }} keyboardVerticalOffset={88}>
        <View style={{ flex: 1, flexDirection: "row" }}>
          <View style={{ flex: 1 }}>{transcript}</View>
          {sidePane}
        </View>
        <Composer
          onSend={(text) => void sendText(text, false)}
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
        onPttStart={onPttStart}
        onPttStop={() => void onPttStop()}
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
