import { View } from "react-native";
import { useTheme } from "./theme";

export function StatusDot({ status, size = 8 }: { status: string; size?: number }) {
  const t = useTheme();
  const color =
    status === "running" ? t.ok : status === "awaiting_input" || status === "awaiting_gate" ? t.warn : status === "error" || status === "failed" ? t.danger : t.border;
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}
