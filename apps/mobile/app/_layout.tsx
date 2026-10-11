import { Stack } from "expo-router";

/** Every screen in this stack is reached from the tabs. When the app is
 *  cold-started straight into one of them — a deep link, or iOS restoring the
 *  app on that screen — there was nothing beneath it, so no Back button and no
 *  way out. Naming the tabs as the initial route puts them under any direct
 *  entry, and Back appears. */
export const unstable_settings = { initialRouteName: "(tabs)" };
import { useEffect } from "react";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { handleNotificationResponses, handleNotificationsReceived } from "~/notifications";
import { AppProvider, useApp } from "~/state/AppContext";

/** Notification buttons (answer, reply, done with step) act here; the ones
 *  that open a screen navigate through the router. */
function NotificationActions() {
  const router = useRouter();
  const { ready, target } = useApp();
  useEffect(() => {
    if (!ready) return;
    let off = () => {};
    let offReceived = () => {};
    void handleNotificationResponses(target.base, (path) => router.push(path as never)).then((f) => (off = f));
    void handleNotificationsReceived().then((f) => (offReceived = f));
    return () => {
      off();
      offReceived();
    };
  }, [ready, target.base, router]);
  return null;
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <NotificationActions />
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerBackTitle: "Back" }}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="sign-in" options={{ title: "Sign in", headerShown: false }} />
          <Stack.Screen name="auth" options={{ headerShown: false }} />
          <Stack.Screen name="devices" options={{ title: "Devices" }} />
          <Stack.Screen name="protocol/[slug]" options={{ title: "Protocol" }} />
          <Stack.Screen name="session/[id]" options={{ title: "Session" }} />
          <Stack.Screen name="run/[id]" options={{ title: "Run" }} />
        </Stack>
      </AppProvider>
    </SafeAreaProvider>
  );
}
