import { Stack } from "expo-router";
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
          <Stack.Screen name="hosts" options={{ title: "Your Macs" }} />
          <Stack.Screen name="devices" options={{ title: "Devices" }} />
          <Stack.Screen name="session/[id]" options={{ title: "Session" }} />
          <Stack.Screen name="run/[id]" options={{ title: "Run" }} />
        </Stack>
      </AppProvider>
    </SafeAreaProvider>
  );
}
