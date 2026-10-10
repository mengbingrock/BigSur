// The step bar pinned above a run's transcript (run-design §5.2): the current
// step in the protocol's words, its amounts, a live timer, Done. Tap the
// header for the checklist; Back and Skip live there too, so a stray tap
// cannot skip a step.
import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import type { RunHandle } from "~/hooks/useRun";
import { amountsLine, clock, elapsed, fraction, remaining } from "~/runs/format";
import { Button } from "./Button";
import { useTheme } from "./theme";

function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function StepBar({ run }: { run: RunHandle }) {
  const t = useTheme();
  const now = useNow();
  const [open, setOpen] = useState(false);
  const d = run.data;
  if (!d) return null;
  const { run: r, view } = d;
  const total = r.snapshot.steps.length;
  const doneCount = view.stepLog.filter((s) => s.doneAt).length;
  const active = r.status === "running" || r.status === "paused";
  // A timer only matters while the run is open; the server cancels them on
  // finish, and a stale one must not keep counting on screen.
  const timer = active ? view.timers.find((x) => x.state === "running") : undefined;
  const left = timer ? remaining(timer.endsAt, now) : 0;
  const stepTimer = view.current?.timer ?? null;
  const live = r.status === "running";
  const elapsedS = r.finishedAt ? view.elapsedSeconds : Math.round((now - new Date(r.startedAt).getTime()) / 1000);

  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: t.border, backgroundColor: t.bg }}>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" testID="step-bar-header" style={{ paddingHorizontal: 12, paddingTop: 8 }}>
        <Text style={{ color: t.muted, fontSize: 12 }}>
          {fraction(r.current, total, r.status, doneCount)} · {elapsed(elapsedS)}
          {r.status === "paused" ? " · paused" : ""}
          {r.scale ? ` · ${r.scale.actual.qty} ${r.scale.actual.unit}` : ""}
        </Text>
      </Pressable>
      <View style={{ margin: 12, marginTop: 6, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: live ? t.accent : t.border, backgroundColor: t.card, gap: 6 }}>
        {view.current ? (
          <>
            <Text testID="step-text" selectable style={{ color: t.text, fontSize: 17, lineHeight: 24 }}>
              {view.current.text.split("\n")[0]}
            </Text>
            {view.current.text.includes("\n") ? (
              <Text style={{ color: t.text, fontSize: 14, lineHeight: 20 }}>{view.current.text.split("\n").slice(1).join("\n")}</Text>
            ) : null}
            {amountsLine(view.current) ? <Text style={{ color: t.muted, fontSize: 12 }}>{amountsLine(view.current)}</Text> : null}
            {view.current.note ? <Text style={{ color: t.muted, fontSize: 12, fontStyle: "italic" }}>{view.current.note}</Text> : null}
          </>
        ) : (
          <Text style={{ color: t.text, fontSize: 16 }}>
            {r.status === "done" ? (doneCount >= total ? "All steps done." : `Run finished after ${doneCount} of ${total} steps.`) : "Run abandoned."}
          </Text>
        )}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 4 }}>
          {timer ? (
            <Pressable onPress={() => void run.cancelTimer(timer.id)} accessibilityLabel="Cancel timer" style={{ flex: 1 }}>
              <Text testID="timer" style={{ color: left === 0 ? t.warn : t.accent, fontSize: 20, fontVariant: ["tabular-nums"], fontWeight: "700" }}>
                ⏱ {clock(left)} {left === 0 ? "done" : "left"}
              </Text>
              <Text style={{ color: t.muted, fontSize: 11 }}>{timer.label} · tap to cancel</Text>
            </Pressable>
          ) : stepTimer && live ? (
            <Button kind="secondary" title={`⏱ Start ${stepTimer.label}`} onPress={() => void run.startTimer()} disabled={run.busy} />
          ) : (
            <View style={{ flex: 1 }} />
          )}
          {live ? <Button testID="step-done" title={r.current >= total ? "Done · finish" : "Done"} onPress={() => void run.advance()} disabled={run.busy} loading={run.busy} /> : null}
          {r.status === "paused" ? <Button title="Resume" onPress={() => void run.resume()} /> : null}
          {r.status === "done" && !r.finishedAt ? <Button title="Finish" onPress={() => void run.finish()} /> : null}
        </View>
      </View>
      {run.error ? <Text style={{ color: t.danger, fontSize: 12, paddingHorizontal: 12, paddingBottom: 6 }}>{run.error}</Text> : null}

      <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setOpen(false)}>
        <View style={{ flex: 1, backgroundColor: t.bg }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16, borderBottomWidth: 1, borderBottomColor: t.border }}>
            <Text style={{ color: t.text, fontSize: 17, fontWeight: "700" }}>{r.protocolName}</Text>
            <Pressable onPress={() => setOpen(false)} hitSlop={12}>
              <Text style={{ color: t.accent, fontSize: 16 }}>Close</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16, gap: 8 }}>
            {view.stepLog.map((s) => {
              const isCurrent = s.n === r.current && live;
              const mark = s.skipped ? "⤼" : s.doneAt ? "✓" : isCurrent ? "●" : "○";
              return (
                <Pressable
                  key={s.n}
                  onPress={() => {
                    setOpen(false);
                    void run.jump(s.n);
                  }}
                  style={{ flexDirection: "row", gap: 10, padding: 10, borderRadius: 10, backgroundColor: isCurrent ? t.card : "transparent", borderWidth: isCurrent ? 1 : 0, borderColor: t.accent }}
                >
                  <Text style={{ color: s.doneAt ? t.ok : s.skipped ? t.warn : isCurrent ? t.accent : t.muted, width: 18 }}>{mark}</Text>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ color: s.doneAt || s.skipped ? t.muted : t.text, fontSize: 14 }}>
                      {s.n}. {s.text.split("\n")[0]}
                    </Text>
                    {s.doneAt ? <Text style={{ color: t.muted, fontSize: 11 }}>done {new Date(s.doneAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</Text> : null}
                    {s.notes.map((n, i) => (
                      <Text key={i} style={{ color: t.muted, fontSize: 12 }}>
                        📝 {n}
                      </Text>
                    ))}
                  </View>
                </Pressable>
              );
            })}
            <View style={{ flexDirection: "row", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
              {live && r.current > 1 ? <Button kind="secondary" title="↩ Back" onPress={() => { setOpen(false); void run.back(); }} /> : null}
              {live ? <Button kind="secondary" title="⤼ Skip this step" onPress={() => { setOpen(false); void run.skip(); }} /> : null}
              {live ? <Button kind="ghost" title="Pause" onPress={() => { setOpen(false); void run.pause(); }} /> : null}
              {r.status !== "abandoned" && !r.finishedAt ? <Button kind="ghost" title="Finish run" onPress={() => { setOpen(false); void run.finish(); }} /> : null}
            </View>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}
