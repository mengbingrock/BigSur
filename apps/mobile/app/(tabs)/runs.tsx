// Runs: everything in progress (run-design §5.4) — protocol runs first,
// research runs as before, finished protocol runs last for their write-ups.
import { useCallback, useEffect, useState } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import { FlatList, Pressable, Text, View } from "react-native";
import { listRuns as listResearch, type RunSummary } from "~/api/research";
import { listRuns, type RunListItem } from "~/api/runs";
import { clock, elapsed, fraction, remaining } from "~/runs/format";
import { useApp } from "~/state/AppContext";
import { Chip } from "~/ui/Chip";
import { Screen } from "~/ui/Screen";
import { StatusDot } from "~/ui/StatusDot";
import { useTheme } from "~/ui/theme";

type Row =
  | { kind: "header"; key: string; title: string }
  | { kind: "run"; key: string; run: RunListItem }
  | { kind: "research"; key: string; run: RunSummary };

export default function RunsScreen() {
  const t = useTheme();
  const router = useRouter();
  const { target } = useApp();
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [research, setResearch] = useState<RunSummary[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    const [a, b] = await Promise.allSettled([listRuns(target), listResearch(target)]);
    if (a.status === "fulfilled") setRuns(a.value.runs);
    if (b.status === "fulfilled") setResearch(b.value.runs);
    const failed = [a, b].find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    setErr(failed ? (failed.reason instanceof Error ? failed.reason.message : String(failed.reason)) : null);
  }, [target]);
  useFocusEffect(
    useCallback(() => {
      void load();
      const id = setInterval(load, 15_000);
      return () => clearInterval(id);
    }, [load]),
  );
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const inProgress = runs.filter((r) => r.status === "running" || r.status === "paused").sort((a, b) => (a.status === b.status ? 0 : a.status === "running" ? -1 : 1));
  const finished = runs.filter((r) => r.status === "done" || r.status === "abandoned");
  const rows: Row[] = [];
  if (inProgress.length) rows.push({ kind: "header", key: "h-progress", title: "IN PROGRESS" }, ...inProgress.map((run) => ({ kind: "run" as const, key: run.id, run })));
  if (research.length) rows.push({ kind: "header", key: "h-research", title: "RESEARCH" }, ...research.map((run) => ({ kind: "research" as const, key: `r-${run.id}`, run })));
  if (finished.length) rows.push({ kind: "header", key: "h-finished", title: "FINISHED" }, ...finished.map((run) => ({ kind: "run" as const, key: run.id, run })));

  const rowStyle = { flexDirection: "row" as const, gap: 10, alignItems: "center" as const, padding: 16, borderBottomWidth: 1, borderBottomColor: t.border };

  return (
    <Screen>
      {err ? <Text style={{ color: t.danger, padding: 12 }}>{err}</Text> : null}
      <FlatList
        data={rows}
        keyExtractor={(r) => r.key}
        renderItem={({ item }) => {
          if (item.kind === "header") {
            return <Text style={{ color: t.muted, fontSize: 11, fontWeight: "700", paddingHorizontal: 16, paddingTop: 12 }}>{item.title}</Text>;
          }
          if (item.kind === "research") {
            const r = item.run;
            return (
              <Pressable onPress={() => router.push(`/run/${r.id}`)} style={rowStyle}>
                <StatusDot status={r.status} />
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} style={{ color: t.text, fontWeight: "600" }}>{r.title}</Text>
                  <Text style={{ color: t.muted, fontSize: 12 }}>
                    {r.status}{r.stage ? ` · ${r.stage}` : ""} · ${r.costUsd.toFixed(2)}
                  </Text>
                </View>
                {r.pendingGates.length ? <Chip label="gate" tone="warn" /> : null}
              </Pressable>
            );
          }
          const r = item.run;
          const live = r.status === "running";
          const left = r.timerEndsAt ? remaining(r.timerEndsAt, now) : null;
          const el = r.finishedAt ? r.elapsedSeconds : Math.round((now - new Date(r.startedAt).getTime()) / 1000);
          return (
            <Pressable testID={`run-${r.id}`} onPress={() => router.push(`/session/${r.sessionId}`)} style={rowStyle}>
              <StatusDot status={live ? "running" : r.status === "paused" ? "awaiting_input" : "idle"} />
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={{ color: t.text, fontWeight: "600" }}>{r.protocolName}</Text>
                <Text style={{ color: t.muted, fontSize: 12 }}>
                  {fraction(r.current, r.total, r.status, r.done)}
                  {r.status === "paused" ? " · paused" : ""}
                  {r.status === "done" || r.status === "abandoned" ? ` · ${new Date(r.updatedAt).toLocaleDateString([], { weekday: "short" })}` : ` · ${elapsed(el)}`}
                  {left !== null ? ` · ⏱ ${clock(left)}` : ""}
                  {r.notes ? ` · ${r.notes} note${r.notes === 1 ? "" : "s"}` : ""}
                </Text>
              </View>
              {left === 0 ? <Chip label="timer done" tone="warn" /> : null}
            </Pressable>
          );
        }}
        ListEmptyComponent={<Text style={{ color: t.muted, padding: 24, textAlign: "center" }}>No runs yet. Open a protocol and tap Start run.</Text>}
      />
    </Screen>
  );
}
