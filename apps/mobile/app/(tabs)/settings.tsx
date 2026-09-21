import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { ScrollView, Switch, Text, TextInput, View } from "react-native";
import { registerForPush } from "~/notifications";
import { useApp } from "~/state/AppContext";
import { getPref, setPref } from "~/storage";
import { Button } from "~/ui/Button";
import { Screen } from "~/ui/Screen";
import { useTheme } from "~/ui/theme";

export default function SettingsScreen() {
  const t = useTheme();
  const router = useRouter();
  const { target, user, setBase, setHostId, signOut } = useApp();
  const [base, setBaseInput] = useState(target.base);
  const [readAloudDefault, setReadAloudDefault] = useState(false);
  const [pushToken, setPushToken] = useState<string | null>(null);

  useEffect(() => {
    void getPref("labee:readAloud").then((v) => setReadAloudDefault(v === "1"));
  }, []);

  const row = { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: t.border, gap: 6 } as const;
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <View style={row}>
          <Text style={{ color: t.muted, fontSize: 12 }}>Signed in as</Text>
          <Text style={{ color: t.text }}>{user?.email ?? "—"}</Text>
        </View>
        <View style={row}>
          <Text style={{ color: t.muted, fontSize: 12 }}>Server</Text>
          <TextInput value={base} onChangeText={setBaseInput} autoCapitalize="none" autoCorrect={false} onBlur={() => void setBase(base)} style={{ borderWidth: 1, borderColor: t.border, borderRadius: 8, padding: 8, color: t.text }} />
          <Text style={{ color: t.muted, fontSize: 12 }}>
            {target.hostId ? `Talking to Mac ${target.hostId} through the relay.` : "Talking to this server directly."}
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button kind="secondary" title="Choose Mac" onPress={() => router.push("/hosts")} />
            {target.hostId ? <Button kind="ghost" title="Direct" onPress={() => void setHostId(undefined)} /> : null}
          </View>
        </View>
        <View style={[row, { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }]}>
          <Text style={{ color: t.text }}>Read replies aloud by default</Text>
          <Switch
            value={readAloudDefault}
            onValueChange={(v) => {
              setReadAloudDefault(v);
              void setPref("labee:readAloud", v ? "1" : "0");
            }}
          />
        </View>
        <View style={row}>
          <Text style={{ color: t.text }}>Notifications</Text>
          <Text style={{ color: t.muted, fontSize: 12 }}>{pushToken ? `Registered (${pushToken.slice(0, 18)}…)` : "Get a push when Labee asks a question or finishes."}</Text>
          <Button kind="secondary" title="Enable notifications" onPress={async () => setPushToken(await registerForPush(target))} />
        </View>
        <View style={row}>
          <Button kind="secondary" title="Devices" onPress={() => router.push("/devices")} />
        </View>
        <View style={{ paddingTop: 24 }}>
          <Button kind="danger" title="Sign out" onPress={async () => { await signOut(); router.replace("/sign-in"); }} />
        </View>
      </ScrollView>
    </Screen>
  );
}
