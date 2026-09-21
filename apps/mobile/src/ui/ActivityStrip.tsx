// Collapsed summary of what the agent did ("Read · Grep · Bash"), expandable
// to a list with each tool's input and (truncated) result.
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { ActivityItem } from "@labee/session-core";
import { useTheme } from "./theme";

function inputPreview(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const key = ["command", "file_path", "pattern", "query", "url", "path"].find((k) => typeof o[k] === "string");
  const v = key ? String(o[key]) : JSON.stringify(o);
  return v.length > 120 ? `${v.slice(0, 120)}…` : v;
}

export function ActivityStrip({ items, live }: { items: ActivityItem[]; live: boolean }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const tools = items.filter((a): a is Extract<ActivityItem, { kind: "tool" }> => a.kind === "tool");
  const thinking = items.some((a) => a.kind === "thinking" && !a.done);
  const status = items.find((a): a is Extract<ActivityItem, { kind: "status" }> => a.kind === "status");
  if (tools.length === 0 && !thinking && !status) return null;
  const summary = tools.length
    ? Array.from(new Set(tools.map((x) => x.name))).slice(0, 4).join(" · ") + (tools.length > 1 ? ` (${tools.length})` : "")
    : thinking
      ? "Thinking…"
      : status?.text ?? "";
  const running = tools.some((x) => !x.done) || thinking;
  return (
    <View style={{ borderWidth: 1, borderColor: t.border, borderRadius: 10, marginTop: 6, overflow: "hidden" }}>
      <Pressable onPress={() => setOpen((o) => !o)} style={{ flexDirection: "row", alignItems: "center", padding: 8, gap: 8 }}>
        <Text style={{ color: t.muted, fontSize: 12 }}>{open ? "▾" : "▸"}</Text>
        <Text numberOfLines={1} style={{ color: t.muted, fontSize: 12, flex: 1 }}>
          {summary}
        </Text>
        {running && live ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: t.ok }} /> : null}
      </Pressable>
      {open ? (
        <ScrollView style={{ maxHeight: 260, borderTopWidth: 1, borderTopColor: t.border }}>
          {tools.map((x) => (
            <View key={x.id} style={{ padding: 8, borderBottomWidth: 1, borderBottomColor: t.border }}>
              <Text style={{ color: t.text, fontSize: 12, fontWeight: "600" }}>
                {x.name} {x.done ? "" : "…"}
              </Text>
              {inputPreview(x.input) ? (
                <Text style={{ color: t.muted, fontSize: 11, fontFamily: t.mono }} numberOfLines={2}>
                  {inputPreview(x.input)}
                </Text>
              ) : null}
              {x.result ? (
                <Text style={{ color: x.resultError ? t.danger : t.muted, fontSize: 11, fontFamily: t.mono, marginTop: 2 }} numberOfLines={4}>
                  {x.result}
                </Text>
              ) : null}
            </View>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}
