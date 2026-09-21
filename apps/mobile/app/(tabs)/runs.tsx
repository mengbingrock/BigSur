import { useCallback, useState } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import { FlatList, Pressable, Text, View } from "react-native";
import { listRuns, type RunSummary } from "~/api/research";
import { useApp } from "~/state/AppContext";
import { Chip } from "~/ui/Chip";
import { Screen } from "~/ui/Screen";
import { StatusDot } from "~/ui/StatusDot";
import { useTheme } from "~/ui/theme";

export default function RunsScreen() {
  const t = useTheme();
  const router = useRouter();
  const { target } = useApp();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setRuns((await listRuns(target)).runs);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [target]);
  useFocusEffect(
    useCallback(() => {
      void load();
      const id = setInterval(load, 15_000);
      return () => clearInterval(id);
    }, [load]),
  );
  return (
    <Screen>
      {err ? <Text style={{ color: t.danger, padding: 12 }}>{err}</Text> : null}
      <FlatList
        data={runs}
        keyExtractor={(r) => r.id}
        renderItem={({ item: r }) => (
          <Pressable onPress={() => router.push(`/run/${r.id}`)} style={{ flexDirection: "row", gap: 10, alignItems: "center", padding: 16, borderBottomWidth: 1, borderBottomColor: t.border }}>
            <StatusDot status={r.status} />
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={{ color: t.text, fontWeight: "600" }}>{r.title}</Text>
              <Text style={{ color: t.muted, fontSize: 12 }}>
                {r.status}{r.stage ? ` · ${r.stage}` : ""} · ${r.costUsd.toFixed(2)}
              </Text>
            </View>
            {r.pendingGates.length ? <Chip label="gate" tone="warn" /> : null}
          </Pressable>
        )}
        ListEmptyComponent={<Text style={{ color: t.muted, padding: 24, textAlign: "center" }}>No research runs.</Text>}
      />
    </Screen>
  );
}
