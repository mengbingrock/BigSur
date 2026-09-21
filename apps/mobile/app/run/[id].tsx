// Research run: stage timeline with live tasks, gate card, cost, and tabs for
// the paper and the claim-verification summary.
import { useCallback, useEffect, useRef, useState } from "react";
import { Stack, useLocalSearchParams } from "expo-router";
import { Pressable, ScrollView, Text, View } from "react-native";
import { answerGate, artifactText, cancelRun, getRun, openRunEvents, type RunEvent, type RunSummary, type TaskRow } from "~/api/research";
import { useApp } from "~/state/AppContext";
import { Button } from "~/ui/Button";
import { Screen } from "~/ui/Screen";
import { StatusDot } from "~/ui/StatusDot";
import { useTheme } from "~/ui/theme";

const STAGES = ["investigate", "discover", "write", "verify"] as const;

export default function RunScreen() {
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { target } = useApp();
  const [run, setRun] = useState<RunSummary | null>(null);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [tab, setTab] = useState<"timeline" | "paper" | "claims">("timeline");
  const [paper, setPaper] = useState<string | null>(null);
  const [claims, setClaims] = useState<string | null>(null);
  const lastSeq = useRef(0);

  const load = useCallback(async () => {
    if (!id) return;
    const r = await getRun(target, id);
    setRun(r.run);
    setTasks(r.tasks);
  }, [target, id]);

  useEffect(() => {
    void load();
    if (!id) return;
    const h = openRunEvents(target, id, lastSeq.current, (e) => {
      if (e.seq > 0) lastSeq.current = Math.max(lastSeq.current, e.seq);
      if (e.type !== "agent_delta" && e.type !== "agent_tool") setEvents((prev) => [...prev.slice(-200), e]);
      if (e.type === "run_status" || e.type === "stage_started" || e.type === "task_finished" || e.type === "gate_waiting") void load();
    });
    return () => h.close();
  }, [target, id, load]);

  useEffect(() => {
    if (!id) return;
    if (tab === "paper" && paper === null) {
      void artifactText(target, id, "stage3/final/paper.md").then(setPaper).catch(() => setPaper("Not available yet."));
    }
    if (tab === "claims" && claims === null) {
      void artifactText(target, id, "stage3/verify/claims.round2.json")
        .catch(() => artifactText(target, id, "stage3/verify/claims.round1.json"))
        .then((txt) => {
          try {
            const j = JSON.parse(txt) as { claims?: { status: string }[] } | { status: string }[];
            const arr = Array.isArray(j) ? j : (j.claims ?? []);
            const counts: Record<string, number> = {};
            for (const c of arr) counts[c.status] = (counts[c.status] ?? 0) + 1;
            setClaims(Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join("\n") || "No claims recorded.");
          } catch {
            setClaims(txt.slice(0, 4000));
          }
        })
        .catch(() => setClaims("Not available yet."));
    }
  }, [tab, paper, claims, target, id]);

  const gate = run?.pendingGates[0];
  const stageIdx = run?.stage ? STAGES.indexOf(run.stage as (typeof STAGES)[number]) : -1;

  return (
    <Screen>
      <Stack.Screen options={{ title: run?.title ?? "Run" }} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 12, borderBottomWidth: 1, borderBottomColor: t.border }}>
        <StatusDot status={run?.status ?? "idle"} />
        <Text style={{ color: t.muted, fontSize: 12, flex: 1 }}>
          {run?.status ?? ""}{run?.stage ? ` · ${run.stage}` : ""} · ${(run?.costUsd ?? 0).toFixed(2)}
        </Text>
        {run && (run.status === "running" || run.status === "awaiting_gate" || run.status === "queued") ? (
          <Button kind="danger" title="Stop" onPress={() => void cancelRun(target, run.id).then(load)} />
        ) : null}
      </View>
      {gate && run ? (
        <View style={{ margin: 12, padding: 12, borderWidth: 1, borderColor: t.warn, borderRadius: 12, gap: 8 }}>
          <Text style={{ color: t.warn, fontWeight: "700", fontSize: 12 }}>GATE · {gate}</Text>
          <Text style={{ color: t.text }}>The run is paused for your approval.</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button title="Approve" onPress={() => void answerGate(target, run.id, gate, true).then(load)} />
            <Button kind="secondary" title="Reject" onPress={() => void answerGate(target, run.id, gate, false).then(load)} />
          </View>
        </View>
      ) : null}
      <View style={{ flexDirection: "row", gap: 16, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: t.border }}>
        {(["timeline", "paper", "claims"] as const).map((k) => (
          <Pressable key={k} onPress={() => setTab(k)}>
            <Text style={{ color: tab === k ? t.accent : t.muted, fontWeight: "600" }}>{k[0]!.toUpperCase() + k.slice(1)}</Text>
          </Pressable>
        ))}
      </View>
      <ScrollView contentContainerStyle={{ padding: 12, gap: 8 }}>
        {tab === "timeline" ? (
          <>
            {STAGES.map((s, i) => (
              <View key={s} style={{ gap: 4 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <StatusDot status={i < stageIdx ? "done" : i === stageIdx ? (run?.status ?? "running") : "idle"} />
                  <Text style={{ color: i <= stageIdx ? t.text : t.muted, fontWeight: i === stageIdx ? "700" : "400" }}>{s}</Text>
                </View>
                {i === stageIdx
                  ? tasks
                      .filter((x) => x.stage === s)
                      .slice(-12)
                      .map((x) => (
                        <Text key={x.id} style={{ color: t.muted, fontSize: 12, marginLeft: 16 }}>
                          {x.status === "running" ? "…" : x.status === "succeeded" ? "✓" : x.status === "failed" ? "✗" : "·"} {x.role}
                          {x.branch ? ` (${x.branch})` : ""}{x.cost_usd ? ` · $${x.cost_usd.toFixed(2)}` : ""}
                        </Text>
                      ))
                  : null}
              </View>
            ))}
            {run?.failReason ? <Text style={{ color: t.danger }}>{run.failReason}</Text> : null}
            <Text style={{ color: t.muted, fontSize: 11, marginTop: 12, fontWeight: "700" }}>RECENT EVENTS</Text>
            {events.slice(-30).reverse().map((e, i) => (
              <Text key={`${e.seq}-${i}`} style={{ color: t.muted, fontSize: 11 }}>
                {new Date(e.ts).toLocaleTimeString()} {e.type}{e.role ? ` · ${e.role}` : ""}
              </Text>
            ))}
          </>
        ) : tab === "paper" ? (
          <Text selectable style={{ color: t.text, lineHeight: 21 }}>{paper ?? "Loading…"}</Text>
        ) : (
          <Text selectable style={{ color: t.text, fontFamily: t.mono }}>{claims ?? "Loading…"}</Text>
        )}
      </ScrollView>
    </Screen>
  );
}
