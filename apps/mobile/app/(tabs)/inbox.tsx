// Everything waiting on a decision: sessions with a pending question and runs
// with a pending gate.
import { useCallback, useState } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import { FlatList, Pressable, Text, View } from "react-native";
import type { SessionSummary } from "@labee/session-core";
import { listRuns, type RunSummary } from "~/api/research";
import { listSessions } from "~/api/sessions";
import { useApp } from "~/state/AppContext";
import { Screen } from "~/ui/Screen";
import { useTheme } from "~/ui/theme";

type Item = { kind: "session"; s: SessionSummary } | { kind: "run"; r: RunSummary };

export default function InboxScreen() {
  const t = useTheme();
  const router = useRouter();
  const { target } = useApp();
  const [items, setItems] = useState<Item[]>([]);
  const load = useCallback(async () => {
    const [s, r] = await Promise.all([
      listSessions(target).catch(() => ({ sessions: [] as SessionSummary[] })),
      listRuns(target).catch(() => ({ runs: [] as RunSummary[] })),
    ]);
    setItems([
      ...s.sessions.filter((x) => x.status === "awaiting_input").map((x) => ({ kind: "session", s: x }) as Item),
      ...r.runs.filter((x) => x.pendingGates.length > 0 || x.status === "awaiting_gate").map((x) => ({ kind: "run", r: x }) as Item),
    ]);
  }, [target]);
  useFocusEffect(
    useCallback(() => {
      void load();
      const id = setInterval(load, 10_000);
      return () => clearInterval(id);
    }, [load]),
  );
  return (
    <Screen>
      <FlatList
        data={items}
        keyExtractor={(i) => (i.kind === "session" ? `s:${i.s.id}` : `r:${i.r.id}`)}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.push(item.kind === "session" ? `/session/${item.s.id}` : `/run/${item.r.id}`)}
            style={{ padding: 16, borderBottomWidth: 1, borderBottomColor: t.border, gap: 4 }}
          >
            <Text style={{ color: t.warn, fontSize: 11, fontWeight: "700" }}>{item.kind === "session" ? "QUESTION" : "GATE"}</Text>
            <Text style={{ color: t.text, fontWeight: "600" }}>{item.kind === "session" ? item.s.title : item.r.title}</Text>
            <View>
              <Text style={{ color: t.muted, fontSize: 12 }}>
                {item.kind === "session" ? "Labee is asking a question" : `Approve: ${item.r.pendingGates.join(", ") || "gate"}`}
              </Text>
            </View>
          </Pressable>
        )}
        ListEmptyComponent={<Text style={{ color: t.muted, padding: 24, textAlign: "center" }}>Nothing is waiting on you.</Text>}
      />
    </Screen>
  );
}
