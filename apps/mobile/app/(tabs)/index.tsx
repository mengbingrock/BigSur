import { useCallback, useEffect, useState } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import type { SessionSummary } from "@labee/session-core";
import { createSession, listSessions } from "~/api/sessions";
import { useApp } from "~/state/AppContext";
import { Button } from "~/ui/Button";
import { Chip } from "~/ui/Chip";
import { Screen } from "~/ui/Screen";
import { StatusDot } from "~/ui/StatusDot";
import { useTheme } from "~/ui/theme";

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export default function SessionsScreen() {
  const t = useTheme();
  const router = useRouter();
  const { target } = useApp();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await listSessions(target);
      setSessions(r.sessions);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [target]);

  useFocusEffect(
    useCallback(() => {
      void load();
      const id = setInterval(load, 10_000);
      return () => clearInterval(id);
    }, [load]),
  );
  useEffect(() => {
    void load();
  }, [load]);

  const running = sessions.filter((s) => s.status === "running" || s.status === "awaiting_input");
  const rest = sessions.filter((s) => !running.includes(s));
  const waiting = sessions.filter((s) => s.status === "awaiting_input").length;

  const newSession = async () => {
    const r = await createSession(target);
    router.push(`/session/${r.session.id}`);
  };

  const Row = ({ s }: { s: SessionSummary }) => (
    <Pressable testID={`session-${s.id}`} onPress={() => router.push(`/session/${s.id}`)} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: t.border }}>
      <StatusDot status={s.status} />
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ color: t.text, fontSize: 15, fontWeight: "600" }}>
          {s.title}
        </Text>
        <Text style={{ color: t.muted, fontSize: 12 }}>
          {s.hostId ? `${s.hostOnline ? "" : "offline · "}` : ""}
          {s.status === "running" ? "running" : s.status === "awaiting_input" ? "waiting on you" : s.status === "error" ? "error" : "idle"} · {ago(s.updatedAt)}
          {s.costUsd ? ` · $${s.costUsd.toFixed(2)}` : ""}
        </Text>
      </View>
      {s.queued ? <Chip label={`${s.queued} queued`} /> : null}
    </Pressable>
  );

  return (
    <Screen>
      {waiting > 0 ? (
        <Pressable onPress={() => router.push("/(tabs)/inbox")} style={{ margin: 12, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: t.warn }}>
          <Text style={{ color: t.warn, fontWeight: "600" }}>⏳ Waiting on you ({waiting})</Text>
        </Pressable>
      ) : null}
      {err ? <Text style={{ color: t.danger, padding: 12 }}>{err}</Text> : null}
      <FlatList
        data={[...running, ...rest]}
        keyExtractor={(s) => s.id}
        renderItem={({ item, index }) => (
          <>
            {index === 0 && running.length > 0 ? <Text style={{ color: t.muted, fontSize: 11, fontWeight: "700", paddingHorizontal: 16, paddingTop: 12 }}>RUNNING</Text> : null}
            {index === running.length && rest.length > 0 ? <Text style={{ color: t.muted, fontSize: 11, fontWeight: "700", paddingHorizontal: 16, paddingTop: 12 }}>RECENT</Text> : null}
            <Row s={item} />
          </>
        )}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
        ListEmptyComponent={<Text style={{ color: t.muted, padding: 24, textAlign: "center" }}>No sessions yet. Start one on your Mac, or tap New.</Text>}
        contentContainerStyle={{ paddingBottom: 96 }}
      />
      <View style={{ position: "absolute", bottom: 16, left: 0, right: 0, alignItems: "center" }}>
        <Button testID="new-session" title="🎤  New" onPress={newSession} />
      </View>
    </Screen>
  );
}
