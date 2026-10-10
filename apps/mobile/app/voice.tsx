import { useEffect } from "react";
import { useRouter } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { activeRun } from "~/api/runs";
import { useApp } from "~/state/AppContext";

/**
 * labee://voice — one press into Lab mode, for the Action Button, Control
 * Center or a Lock Screen control. Opens the run in progress, or a new chat
 * when nothing is running, in Voice mode and already listening, so the next
 * thing said ("done", "how much TSS") needs no app name and no Siri.
 */
export default function VoiceEntry() {
  const router = useRouter();
  const { target } = useApp();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await activeRun(target).catch(() => null);
      if (cancelled) return;
      const open = r && (r.run.status === "running" || r.run.status === "paused");
      router.replace(`/session/${open ? r.run.sessionId : "new"}?voice=1&listen=1`);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <ActivityIndicator />
    </View>
  );
}
