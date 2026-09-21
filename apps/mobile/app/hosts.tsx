// Pick which linked Mac to talk to (relay mode). Lists /api/link/hosts on the
// box; "Direct" means the server itself runs the sessions.
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { FlatList, Pressable, Text, View } from "react-native";
import { listHosts, type HostInfo } from "~/api/link";
import { useApp } from "~/state/AppContext";
import { Screen } from "~/ui/Screen";
import { StatusDot } from "~/ui/StatusDot";
import { useTheme } from "~/ui/theme";

export default function HostsScreen() {
  const t = useTheme();
  const router = useRouter();
  const { target, setHostId } = useApp();
  const [hosts, setHosts] = useState<HostInfo[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setHosts((await listHosts({ base: target.base })).hosts);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [target.base]);
  useEffect(() => {
    void load();
  }, [load]);
  const pick = async (hostId: string | undefined) => {
    await setHostId(hostId);
    router.back();
  };
  return (
    <Screen>
      {err ? <Text style={{ color: t.danger, padding: 12 }}>{err}</Text> : null}
      <FlatList
        data={[{ hostId: "", name: "This server (direct)", online: true, lastSeenAt: null }, ...hosts]}
        keyExtractor={(h) => h.hostId || "direct"}
        renderItem={({ item: h }) => (
          <Pressable onPress={() => pick(h.hostId || undefined)} style={{ flexDirection: "row", alignItems: "center", gap: 10, padding: 16, borderBottomWidth: 1, borderBottomColor: t.border }}>
            <StatusDot status={h.online ? "running" : "idle"} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontWeight: "600" }}>{h.name}</Text>
              <Text style={{ color: t.muted, fontSize: 12 }}>{h.online ? "online" : `offline${h.lastSeenAt ? ` · last seen ${new Date(h.lastSeenAt).toLocaleString()}` : ""}`}</Text>
            </View>
            {(target.hostId ?? "") === h.hostId ? <Text style={{ color: t.accent }}>✓</Text> : null}
          </Pressable>
        )}
      />
    </Screen>
  );
}
