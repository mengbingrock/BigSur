import { Text, View } from "react-native";
import { useTheme } from "./theme";

export function Chip({ label, tone = "muted" }: { label: string; tone?: "muted" | "accent" | "warn" | "danger" }) {
  const t = useTheme();
  const color = tone === "accent" ? t.accent : tone === "warn" ? t.warn : tone === "danger" ? t.danger : t.muted;
  return (
    <View style={{ borderWidth: 1, borderColor: color, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, alignSelf: "flex-start" }}>
      <Text style={{ color, fontSize: 11, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}
