import { Stack } from "expo-router";

/** Every screen in this stack is reached from the tabs. When the app is
 *  cold-started straight into one of them — a deep link, or iOS restoring the
 *  app on that screen — there was nothing beneath it, so no Back button and no
 *  way out. Naming the tabs as the initial route puts them under any direct
 *  entry, and Back appears. */
export const unstable_settings = { initialRouteName: "(tabs)" };
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppProvider } from "~/state/AppContext";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerBackTitle: "Back" }}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="sign-in" options={{ title: "Sign in", headerShown: false }} />
          <Stack.Screen name="auth" options={{ headerShown: false }} />
          <Stack.Screen name="devices" options={{ title: "Devices" }} />
          <Stack.Screen name="session/[id]" options={{ title: "Session" }} />
          <Stack.Screen name="run/[id]" options={{ title: "Run" }} />
        </Stack>
      </AppProvider>
    </SafeAreaProvider>
  );
}
