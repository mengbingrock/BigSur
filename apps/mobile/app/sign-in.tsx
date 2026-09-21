import { useState } from "react";
import { useRouter } from "expo-router";
import { KeyboardAvoidingView, Platform, Text, TextInput, View } from "react-native";
import { Button } from "~/ui/Button";
import { Screen } from "~/ui/Screen";
import { useTheme } from "~/ui/theme";
import { useApp } from "~/state/AppContext";

export default function SignIn() {
  const t = useTheme();
  const router = useRouter();
  const { target, setBase, signIn, signInWithGoogle } = useApp();
  const [googleBusy, setGoogleBusy] = useState(false);
  const [base, setBaseInput] = useState(target.base);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await setBase(base);
      await signIn(email.trim(), password);
      router.replace("/(tabs)");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const input = { borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 12, color: t.text, backgroundColor: t.card } as const;
  return (
    <Screen edges={["top", "bottom", "left", "right"]}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, justifyContent: "center", padding: 24, gap: 12 }}>
        <Text style={{ color: t.text, fontSize: 28, fontWeight: "700" }}>Labee</Text>
        <Text style={{ color: t.muted, marginBottom: 8 }}>Attach to the agent sessions running on your Mac.</Text>
        <Text style={{ color: t.muted, fontSize: 12 }}>Server</Text>
        <TextInput testID="base" value={base} onChangeText={setBaseInput} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={input} placeholder="https://labee.online" placeholderTextColor={t.muted} />
        <Text style={{ color: t.muted, fontSize: 12 }}>Email</Text>
        <TextInput testID="email" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" textContentType="username" style={input} placeholderTextColor={t.muted} />
        <Text style={{ color: t.muted, fontSize: 12 }}>Password</Text>
        <TextInput testID="password" value={password} onChangeText={setPassword} secureTextEntry textContentType="password" style={input} onSubmitEditing={submit} placeholderTextColor={t.muted} />
        {err ? <Text style={{ color: t.danger }}>{err}</Text> : null}
        <Button testID="sign-in" title="Sign in" onPress={submit} loading={busy} disabled={busy || !email || !password} />
        <Text style={{ color: t.muted, fontSize: 12, textAlign: "center", marginTop: 8 }}>or</Text>
        <Button
          testID="sign-in-google"
          kind="secondary"
          title="Sign in with Google"
          loading={googleBusy}
          disabled={googleBusy}
          onPress={async () => {
            setGoogleBusy(true);
            setErr(null);
            try {
              await setBase(base);
              await signInWithGoogle();
              router.replace("/(tabs)");
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            } finally {
              setGoogleBusy(false);
            }
          }}
        />
      </KeyboardAvoidingView>
    </Screen>
  );
}
