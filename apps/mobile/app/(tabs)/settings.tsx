import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { Alert, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { registerForPush } from "~/notifications";
import { useApp } from "~/state/AppContext";
import { getPref, setPref } from "~/storage";
import { Button } from "~/ui/Button";
import { Screen } from "~/ui/Screen";
import { useTheme } from "~/ui/theme";

export default function SettingsScreen() {
  const t = useTheme();
  const router = useRouter();
  const { target, user, setBase, setHostId, signOut, deleteAccount } = useApp();
  const [base, setBaseInput] = useState(target.base);
  const [readAloudDefault, setReadAloudDefault] = useState(false);
  const [pushToken, setPushToken] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Two confirmations: the first explains what goes, the second is the point
  // of no return. Apple reviews for a real in-app path, not a mailto link.
  const confirmDelete = () => {
    Alert.alert(
      "Delete your account?",
      `This permanently erases the account ${user?.email ?? ""}, every session and transcript, your devices, and your billing records, and cancels any subscription.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Continue",
          style: "destructive",
          onPress: () =>
            Alert.alert("This cannot be undone", "Delete the account now?", [
              { text: "Keep my account", style: "cancel" },
              {
                text: "Delete",
                style: "destructive",
                onPress: async () => {
                  setDeleting(true);
                  try {
                    await deleteAccount();
                    router.replace("/sign-in");
                  } catch (e) {
                    Alert.alert(
                      "Could not delete account",
                      e instanceof Error ? e.message : "Please try again, or email support@labee.online.",
                    );
                  } finally {
                    setDeleting(false);
                  }
                },
              },
            ]),
        },
      ],
    );
  };

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
            {/* "" (not undefined) records an explicit Direct choice, so the
                first-sign-in auto-select in AppContext does not override it. */}
            {target.hostId ? <Button kind="ghost" title="Direct" onPress={() => void setHostId("")} /> : null}
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
        <View style={{ paddingTop: 32, gap: 6 }}>
          <Text style={{ color: t.muted, fontSize: 12 }}>Account</Text>
          <Text style={{ color: t.muted, fontSize: 12 }}>
            Deleting your account erases your sessions, transcripts, devices and billing records from Labee and cancels any subscription. This cannot be undone.
          </Text>
          <Button
            kind="ghost"
            title={deleting ? "Deleting…" : "Delete account"}
            disabled={deleting}
            onPress={confirmDelete}
          />
        </View>
      </ScrollView>
    </Screen>
  );
}
