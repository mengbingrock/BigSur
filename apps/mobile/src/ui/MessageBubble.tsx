import { Text, View } from "react-native";
import type { AskUserAnswer, TranscriptMessage } from "@labee/session-core";
import { ActivityStrip } from "./ActivityStrip";
import { Chip } from "./Chip";
import { QuestionCard } from "./QuestionCard";
import { useTheme } from "./theme";

/** Plain-text rendering with monospace code fences (no markdown dependency). */
function Body({ text, color, mono }: { text: string; color: string; mono: string }) {
  const parts = text.split(/```/);
  return (
    <View style={{ gap: 6 }}>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <Text key={i} selectable style={{ color, fontFamily: mono, fontSize: 12, backgroundColor: "rgba(127,127,127,0.12)", padding: 8, borderRadius: 6 }}>
            {p.replace(/^[a-z]*\n/, "")}
          </Text>
        ) : p.trim() ? (
          <Text key={i} selectable style={{ color, fontSize: 15, lineHeight: 21 }}>
            {p.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/^#+\s*/gm, "").trim()}
          </Text>
        ) : null,
      )}
    </View>
  );
}

export function MessageBubble({
  m,
  live,
  onAnswer,
  voiceText,
  answering,
}: {
  m: TranscriptMessage;
  live: boolean;
  onAnswer?: (answers: AskUserAnswer[]) => void;
  voiceText?: string | null;
  answering?: boolean;
}) {
  const t = useTheme();
  const isUser = m.role === "user";
  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 6, alignItems: isUser ? "flex-end" : "stretch" }}>
      <View
        style={{
          maxWidth: isUser ? "85%" : "100%",
          backgroundColor: isUser ? t.userBubble : "transparent",
          borderRadius: 14,
          padding: isUser ? 10 : 0,
        }}
      >
        <View style={{ flexDirection: "row", gap: 6, alignItems: "center", marginBottom: 4 }}>
          <Text style={{ color: t.muted, fontSize: 11, fontWeight: "600" }}>{isUser ? "You" : "Labee"}</Text>
          {m.device ? <Chip label={m.device} /> : null}
          {m.pending && live ? <Chip label="working" tone="accent" /> : null}
          {m.cancelled ? <Chip label="stopped" /> : null}
        </View>
        {m.content ? <Body text={m.content} color={t.text} mono={t.mono} /> : m.pending ? <Text style={{ color: t.muted }}>…</Text> : null}
        {!isUser ? <ActivityStrip items={m.activity} live={live && m.pending} /> : null}
        {m.error ? <Text style={{ color: t.danger, marginTop: 6 }}>{m.error}</Text> : null}
        {m.question ? (
          <QuestionCard
            questions={m.question.questions}
            answers={m.question.answers}
            onSubmit={onAnswer ?? (() => {})}
            voiceText={onAnswer ? (voiceText ?? null) : null}
            busy={answering}
          />
        ) : null}
        {m.stats?.costUsd !== undefined && !isUser ? (
          <Text style={{ color: t.muted, fontSize: 11, marginTop: 4 }}>${m.stats.costUsd.toFixed(3)}{m.stats.durationMs ? ` · ${Math.round(m.stats.durationMs / 1000)}s` : ""}</Text>
        ) : null}
      </View>
    </View>
  );
}
