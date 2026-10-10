// One protocol, read-only: its steps as written on the machine that holds it.
// Two ways on: "Ask about this" opens a chat with the protocol attached;
// "Start run" previews the parsed steps, asks the scale when the protocol
// names a working volume, and starts a run (run-design §5.1).
import { useCallback, useEffect, useMemo, useState } from "react";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { parseProtocol } from "@labee/session-core";
import { getProtocol, type Protocol } from "~/api/protocols";
import { startRun, type RunScale } from "~/api/runs";
import { createSession } from "~/api/sessions";
import { registerForPush } from "~/notifications";
import { parseScale, summaryLine } from "~/runs/format";
import { useApp } from "~/state/AppContext";
import { Button } from "~/ui/Button";
import { Chip } from "~/ui/Chip";
import { Screen } from "~/ui/Screen";
import { useTheme } from "~/ui/theme";

export default function ProtocolScreen() {
  const t = useTheme();
  const router = useRouter();
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { target } = useApp();
  const [p, setP] = useState<Protocol | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [scaleInput, setScaleInput] = useState("");

  const load = useCallback(async () => {
    if (!slug) return;
    try {
      const r = await getProtocol(target, slug);
      setP(r.skill);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [slug, target]);
  useEffect(() => {
    void load();
  }, [load]);

  // The same parser the server freezes with, so the preview is what the
  // run will be.
  const snapshot = useMemo(() => (p ? parseProtocol(p.body) : null), [p]);

  // Carry the protocol into a chat: the session opens with it attached, so the
  // first question is answered against these steps.
  const discuss = async () => {
    if (!p) return;
    setStarting(true);
    try {
      const r = await createSession(target, { title: p.name });
      router.push(`/session/${r.session.id}?skill=${encodeURIComponent(p.slug)}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const start = async () => {
    if (!p || !snapshot) return;
    let scale: RunScale | null = null;
    if (snapshot.base && scaleInput.trim()) {
      const actual = parseScale(scaleInput, snapshot.base);
      if (!actual) {
        setErr("Say the volume as a number, like 50 or 50 ml.");
        return;
      }
      scale = { base: { qty: snapshot.base.qty, unit: snapshot.base.unit }, actual };
    }
    setStarting(true);
    try {
      const r = await startRun(target, { protocolSlug: p.slug, scale });
      setSheet(false);
      // Timer alerts and the Done button on notifications need permission;
      // ask now, the first time it matters, instead of leaving it to Settings.
      void registerForPush(target);
      router.push(`/session/${r.run.sessionId}?skill=${encodeURIComponent(p.slug)}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: p?.name ?? "Protocol" }} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {err ? <Text style={{ color: t.danger }}>{err}</Text> : null}
        {p ? (
          <>
            <Text style={{ color: t.text, fontSize: 20, fontWeight: "700" }}>{p.name}</Text>
            {p.description ? <Text style={{ color: t.muted, fontSize: 14 }}>{p.description}</Text> : null}
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              {p.category ? <Chip label={p.category} /> : null}
              <Chip label={p.sourceLabel} tone="accent" />
            </View>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button testID="start-run" title="▶ Start run" onPress={() => setSheet(true)} disabled={starting || !snapshot || snapshot.steps.length === 0} />
              <Button kind="secondary" title={starting ? "Opening…" : "Ask about this"} onPress={discuss} disabled={starting} />
            </View>
            <Body text={p.body} />
          </>
        ) : !err ? (
          <Text style={{ color: t.muted }}>Loading…</Text>
        ) : null}
      </ScrollView>

      <Modal visible={sheet} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setSheet(false)}>
        <View style={{ flex: 1, backgroundColor: t.bg }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16, borderBottomWidth: 1, borderBottomColor: t.border }}>
            <Text style={{ color: t.text, fontSize: 17, fontWeight: "700" }}>Start run</Text>
            <Pressable onPress={() => setSheet(false)} hitSlop={12}>
              <Text style={{ color: t.accent, fontSize: 16 }}>Cancel</Text>
            </Pressable>
          </View>
          {snapshot ? (
            <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
              <Text style={{ color: t.text, fontSize: 16, fontWeight: "600" }}>{p?.name}</Text>
              <Text testID="run-summary" style={{ color: t.muted, fontSize: 13 }}>{summaryLine(snapshot)}</Text>
              {snapshot.loose ? (
                <Text style={{ color: t.warn, fontSize: 13 }}>
                  This protocol has no numbered procedure, so each paragraph becomes a step. Ask Labee to structure it first if that looks wrong.
                </Text>
              ) : null}
              {snapshot.base ? (
                <View style={{ gap: 6 }}>
                  <Text style={{ color: t.text, fontSize: 14 }}>
                    Written for {snapshot.base.qty} {snapshot.base.unit}. What volume are you running? (leave empty for the protocol's)
                  </Text>
                  <TextInput
                    testID="scale-input"
                    value={scaleInput}
                    onChangeText={setScaleInput}
                    keyboardType="decimal-pad"
                    placeholder={`${snapshot.base.qty} ${snapshot.base.unit}`}
                    placeholderTextColor={t.muted}
                    style={{ borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 10, color: t.text, backgroundColor: t.card }}
                  />
                </View>
              ) : null}
              <View style={{ gap: 6 }}>
                {snapshot.steps.map((s) => (
                  <View key={s.n} style={{ flexDirection: "row", gap: 8 }}>
                    <Text style={{ color: t.muted, width: 22, textAlign: "right" }}>{s.n}.</Text>
                    <Text style={{ color: t.text, flex: 1, fontSize: 14 }}>
                      {s.text.split("\n")[0]}
                      {s.timer ? <Text style={{ color: t.accent }}>  ⏱ {s.timer.label}</Text> : null}
                    </Text>
                  </View>
                ))}
              </View>
              {err ? <Text style={{ color: t.danger }}>{err}</Text> : null}
              <Button testID="confirm-start" title={starting ? "Starting…" : "Start"} onPress={start} disabled={starting} loading={starting} />
            </ScrollView>
          ) : null}
        </View>
      </Modal>
    </Screen>
  );
}

/** Plain-text rendering with monospace code fences, as in MessageBubble. */
function Body({ text }: { text: string }) {
  const t = useTheme();
  const parts = text.split(/```/);
  return (
    <View style={{ gap: 8, paddingTop: 4 }}>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <Text
            key={i}
            selectable
            style={{ color: t.text, fontFamily: t.mono, fontSize: 12, backgroundColor: "rgba(127,127,127,0.12)", padding: 8, borderRadius: 6 }}
          >
            {part.replace(/^[a-z]*\n/, "")}
          </Text>
        ) : part.trim() ? (
          <Text key={i} selectable style={{ color: t.text, fontSize: 15, lineHeight: 22 }}>
            {part.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/^#+\s*/gm, "").trim()}
          </Text>
        ) : null,
      )}
    </View>
  );
}
