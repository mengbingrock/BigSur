// AskUserQuestion card: one or more questions, single/multi select, answer by
// tap or by voice (the parent passes the last transcript in as `voiceText`).
import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import type { AskUserAnswer, AskUserQuestionItem } from "@labee/session-core";
import { Button } from "./Button";
import { useTheme } from "./theme";

export function QuestionCard({
  questions,
  answers,
  onSubmit,
  voiceText,
  busy,
}: {
  questions: AskUserQuestionItem[];
  answers?: AskUserAnswer[];
  onSubmit: (answers: AskUserAnswer[]) => void;
  voiceText?: string | null;
  busy?: boolean;
}) {
  const t = useTheme();
  const [picks, setPicks] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});

  // A spoken answer fills the first unanswered question; "A" or "option 2"
  // map to labels, anything else becomes free text.
  useEffect(() => {
    if (!voiceText) return;
    const qi = questions.findIndex((_, i) => !(picks[i]?.length || other[i]));
    if (qi === -1) return;
    const q = questions[qi]!;
    const norm = voiceText.trim().toLowerCase();
    const byLabel = q.options.find((o) => o.label.toLowerCase() === norm || norm.includes(o.label.toLowerCase()));
    const m = norm.match(/(?:option|number)\s*(\d+)/);
    const byIndex = m ? q.options[Number(m[1]) - 1] : undefined;
    const pick = byLabel ?? byIndex;
    if (pick) setPicks((p) => ({ ...p, [qi]: [pick.label] }));
    else setOther((o) => ({ ...o, [qi]: voiceText.trim() }));
  }, [voiceText, questions, picks, other]);

  const done = Boolean(answers);
  const complete = questions.every((_, i) => (picks[i]?.length ?? 0) > 0 || (other[i] ?? "").trim());

  return (
    <View style={{ borderWidth: 1, borderColor: t.warn, borderRadius: 12, padding: 12, marginTop: 8, gap: 10, backgroundColor: t.card }}>
      <Text style={{ color: t.warn, fontWeight: "700", fontSize: 12 }}>LABEE IS ASKING</Text>
      {questions.map((q, i) => (
        <View key={i} style={{ gap: 6 }}>
          {q.header ? <Text style={{ color: t.muted, fontSize: 12 }}>{q.header}</Text> : null}
          <Text style={{ color: t.text, fontSize: 15 }}>{q.question}</Text>
          {q.options.map((o) => {
            const selected = done ? (Array.isArray(answers?.[i]?.answer) ? (answers![i]!.answer as string[]).includes(o.label) : answers?.[i]?.answer === o.label) : picks[i]?.includes(o.label);
            return (
              <Pressable
                key={o.label}
                disabled={done}
                onPress={() =>
                  setPicks((p) => {
                    const cur = p[i] ?? [];
                    const next = q.multiSelect ? (cur.includes(o.label) ? cur.filter((x) => x !== o.label) : [...cur, o.label]) : [o.label];
                    return { ...p, [i]: next };
                  })
                }
                style={{ flexDirection: "row", gap: 8, alignItems: "center", padding: 8, borderRadius: 8, borderWidth: 1, borderColor: selected ? t.accent : t.border }}
              >
                <Text style={{ color: selected ? t.accent : t.muted }}>{selected ? "●" : "○"}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: t.text }}>{o.label}</Text>
                  {o.description ? <Text style={{ color: t.muted, fontSize: 12 }}>{o.description}</Text> : null}
                </View>
              </Pressable>
            );
          })}
          {!done ? (
            <TextInput
              placeholder="Other…"
              placeholderTextColor={t.muted}
              value={other[i] ?? ""}
              onChangeText={(v) => setOther((o) => ({ ...o, [i]: v }))}
              style={{ borderWidth: 1, borderColor: t.border, borderRadius: 8, padding: 8, color: t.text }}
            />
          ) : null}
        </View>
      ))}
      {done ? (
        <Text style={{ color: t.muted, fontSize: 12 }}>Answered.</Text>
      ) : (
        <Button
          title="Send answers"
          disabled={!complete || busy}
          loading={busy}
          onPress={() =>
            onSubmit(
              questions.map((q, i) => {
                const o = (other[i] ?? "").trim();
                const p = picks[i] ?? [];
                const answer = o ? o : q.multiSelect ? p : p[0] ?? "";
                return { question: q.question, answer };
              }),
            )
          }
        />
      )}
    </View>
  );
}
