// One protocol, read-only: its steps as written on the machine that holds it.
// Plain text with monospace fences, the same treatment as a chat message —
// the app carries no markdown renderer.
import { useCallback, useEffect, useState } from "react";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { ScrollView, Text, View } from "react-native";
import { getProtocol, type Protocol } from "~/api/protocols";
import { createSession } from "~/api/sessions";
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
            <Button title={starting ? "Opening…" : "Ask about this"} onPress={discuss} disabled={starting} />
            <Body text={p.body} />
          </>
        ) : !err ? (
          <Text style={{ color: t.muted }}>Loading…</Text>
        ) : null}
      </ScrollView>
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
