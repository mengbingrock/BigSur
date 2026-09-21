import { Redirect, Tabs } from "expo-router";
import { Text, type ColorValue } from "react-native";
import { useApp } from "~/state/AppContext";
import { useTheme } from "~/ui/theme";

function Icon({ glyph, color }: { glyph: string; color: ColorValue }) {
  return <Text style={{ fontSize: 18, color }}>{glyph}</Text>;
}

export default function TabsLayout() {
  const { ready, user } = useApp();
  const t = useTheme();
  if (ready && !user) return <Redirect href="/sign-in" />;
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: t.accent, headerStyle: { backgroundColor: t.bg }, headerTintColor: t.text }}>
      <Tabs.Screen name="index" options={{ title: "Sessions", tabBarIcon: ({ color }) => <Icon glyph="💬" color={color} /> }} />
      <Tabs.Screen name="runs" options={{ title: "Runs", tabBarIcon: ({ color }) => <Icon glyph="🧪" color={color} /> }} />
      <Tabs.Screen name="inbox" options={{ title: "Inbox", tabBarIcon: ({ color }) => <Icon glyph="⏳" color={color} /> }} />
      <Tabs.Screen name="settings" options={{ title: "Settings", tabBarIcon: ({ color }) => <Icon glyph="⚙️" color={color} /> }} />
    </Tabs>
  );
}
