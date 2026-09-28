// Every device in one place, matching the web's "My Device" page: the Macs
// this account can run on (pick one, or run on the server directly), and the
// phones and tablets paired to the account — including this one.
import { useCallback, useEffect, useState } from "react";
import { ScrollView, Pressable, Text, View } from "react-native";
import {
  listDevices,
  listHosts,
  requestPairing,
  revokeDevice,
  type DeviceInfo,
  type HostInfo,
} from "~/api/link";
import { deviceLabel, setDeviceToken } from "~/api/client";
import { Stack, useRouter } from "expo-router";
import { useApp } from "~/state/AppContext";
import { setSecret } from "~/storage";
import { Button } from "~/ui/Button";
import { Chip } from "~/ui/Chip";
import { Screen } from "~/ui/Screen";
import { StatusDot } from "~/ui/StatusDot";
import { useTheme } from "~/ui/theme";

export default function DevicesScreen() {
  const t = useTheme();
  const router = useRouter();
  const { target, ready, user, setHostId } = useApp();
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [hosts, setHosts] = useState<HostInfo[]>([]);
  const [code, setCode] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const root = { base: target.base };
  const load = useCallback(async () => {
    try {
      const [d, h] = await Promise.all([listDevices(root), listHosts(root)]);
      setDevices(d.devices);
      setHosts(h.hosts);
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

  const heading = { color: t.muted, fontSize: 12, paddingHorizontal: 16, paddingTop: 20, paddingBottom: 6 } as const;
  const rowStyle = {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: t.border,
  } as const;
  // "" (not undefined) records an explicit Direct choice: AppContext only
  // auto-picks a Mac while the stored preference is absent.
  const macs: HostInfo[] = [{ hostId: "", name: "This server (direct)", online: true, lastSeenAt: null }, ...hosts];

  return (
    <Screen>
      <ExitWhenStranded />
      <ScrollView>
        {err ? <Text style={{ color: t.danger, paddingHorizontal: 16, paddingTop: 12 }}>{err}</Text> : null}

        <Text style={heading}>WHERE CHATS RUN</Text>
        {macs.map((h) => (
          <Pressable key={h.hostId || "direct"} onPress={() => void setHostId(h.hostId)} style={rowStyle}>
            <StatusDot status={h.online ? "running" : "idle"} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontWeight: "600" }}>{h.name}</Text>
              <Text style={{ color: t.muted, fontSize: 12 }}>
                {h.online ? "online" : `offline${h.lastSeenAt ? ` · last seen ${new Date(h.lastSeenAt).toLocaleString()}` : ""}`}
              </Text>
            </View>
            {(target.hostId ?? "") === h.hostId ? <Text style={{ color: t.accent }}>✓</Text> : null}
          </Pressable>
        ))}

        <Text style={heading}>PHONES AND TABLETS</Text>
        <View style={{ paddingHorizontal: 16, paddingBottom: 8, gap: 8 }}>
          <Text style={{ color: t.muted, fontSize: 12 }}>
            Pair this device with your Mac. Approve it on the Mac under Settings › Devices using the code shown here.
          </Text>
          <Button title="Pair this device" onPress={pair} />
          {code ? (
            <Text style={{ color: t.text, fontSize: 32, fontWeight: "700", letterSpacing: 6, textAlign: "center" }}>{code}</Text>
          ) : null}
        </View>
        {devices.map((d) => (
          <View key={d.id} style={rowStyle}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontWeight: "600" }}>{d.name}</Text>
              <Text style={{ color: t.muted, fontSize: 12 }}>
                {d.platform ?? ""} · {d.status}
                {d.code && d.status === "pending" ? ` · code ${d.code}` : ""}
              </Text>
            </View>
            <Chip label={d.status} tone={d.status === "approved" ? "accent" : d.status === "pending" ? "warn" : "danger"} />
            {d.status !== "revoked" ? (
              <Button kind="ghost" title="Revoke" onPress={async () => { await revokeDevice(root, d.id); await load(); }} />
            ) : null}
          </View>
        ))}
        <View style={{ height: 32 }} />
      </ScrollView>
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
