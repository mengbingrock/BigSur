import { useCallback, useEffect, useState } from "react";
import { FlatList, Text, View } from "react-native";
import { listDevices, requestPairing, revokeDevice, type DeviceInfo } from "~/api/link";
import { deviceLabel, setDeviceToken } from "~/api/client";
import { Stack, useRouter } from "expo-router";
import { useApp } from "~/state/AppContext";
import { setSecret } from "~/storage";
import { Button } from "~/ui/Button";
import { Chip } from "~/ui/Chip";
import { Screen } from "~/ui/Screen";
import { useTheme } from "~/ui/theme";

export default function DevicesScreen() {
  const t = useTheme();
  const router = useRouter();
  const { target, ready, user } = useApp();
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [code, setCode] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const root = { base: target.base };
  const load = useCallback(async () => {
    try {
      setDevices((await listDevices(root)).devices);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [target.base]);
  // Not before the stored session is back: fetching on first paint answered
  // "Unauthorized." on a cold start, before the app knew who was signed in.
  // And with no account at all, this screen has nothing to show.
  useEffect(() => {
    if (!ready) return;
    if (!user) {
      router.replace("/sign-in");
      return;
    }
    void load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [ready, user, load, router]);
  const pair = async () => {
    try {
      const r = await requestPairing(root, { name: deviceLabel(), platform: deviceLabel() });
      setDeviceToken(r.token);
      await setSecret("labee:deviceToken", r.token);
      setCode(r.device.code);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Screen>
      <ExitWhenStranded />
      <View style={{ padding: 16, gap: 8 }}>
        <Text style={{ color: t.muted, fontSize: 12 }}>
          Pair this device with your Mac. Approve it on the Mac under Settings › Devices using the code shown here.
        </Text>
        <Button title="Pair this device" onPress={pair} />
        {code ? <Text style={{ color: t.text, fontSize: 32, fontWeight: "700", letterSpacing: 6, textAlign: "center" }}>{code}</Text> : null}
        {err ? <Text style={{ color: t.danger }}>{err}</Text> : null}
      </View>
      <FlatList
        data={devices}
        keyExtractor={(d) => d.id}
        renderItem={({ item: d }) => (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, padding: 16, borderBottomWidth: 1, borderBottomColor: t.border }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontWeight: "600" }}>{d.name}</Text>
              <Text style={{ color: t.muted, fontSize: 12 }}>{d.platform ?? ""} · {d.status}{d.code && d.status === "pending" ? ` · code ${d.code}` : ""}</Text>
            </View>
            <Chip label={d.status} tone={d.status === "approved" ? "accent" : d.status === "pending" ? "warn" : "danger"} />
            {d.status !== "revoked" ? <Button kind="ghost" title="Revoke" onPress={async () => { await revokeDevice(root, d.id); await load(); }} /> : null}
          </View>
        )}
      />
    </Screen>
  );
}

/** A way out when there is nothing to go back to. The root stack now names
 *  the tabs as its initial route, so Back is normally there; this covers any
 *  path that still lands here with an empty history. */
function ExitWhenStranded() {
  const router = useRouter();
  const t = useTheme();
  if (router.canGoBack()) return null;
  return (
    <Stack.Screen
      options={{
        headerLeft: () => (
          <Text
            onPress={() => router.replace("/(tabs)/settings")}
            style={{ color: t.accent, fontSize: 17, paddingHorizontal: 4 }}
          >
            Done
          </Text>
        ),
      }}
    />
  );
}
