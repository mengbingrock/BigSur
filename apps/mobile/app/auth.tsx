import { useEffect } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { setSessionToken } from "~/api/client";
import { useApp } from "~/state/AppContext";
import { setPref, setSecret } from "~/storage";

/**
 * labee://auth?session=…&base=… — the return target for the hosted Google
 * sign-in (the server redirects here with a sealed session) and for any
 * sign-in link. Persists the session, then sends the app to the tabs.
 */
export default function AuthReturn() {
  const router = useRouter();
  const { refresh, setBase } = useApp();
  const { session, base } = useLocalSearchParams<{ session?: string; base?: string }>();

  useEffect(() => {
    void (async () => {
      if (base) await setBase(String(base));
      if (session) {
        const sealed = String(session);
        setSessionToken(sealed);
        await setSecret("labee:session", sealed);
      }
      await setPref("labee:hasAuthed", "1");
      await refresh();
      router.replace("/(tabs)");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <ActivityIndicator />
    </View>
  );
}
