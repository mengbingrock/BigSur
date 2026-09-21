import { ActivityIndicator, Pressable, Text, type PressableProps } from "react-native";
import { useTheme } from "./theme";

export function Button({
  title,
  kind = "primary",
  loading,
  ...rest
}: PressableProps & { title: string; kind?: "primary" | "secondary" | "danger" | "ghost"; loading?: boolean }) {
  const t = useTheme();
  const bg = kind === "primary" ? t.accent : kind === "danger" ? t.danger : "transparent";
  const fg = kind === "primary" ? t.accentText : kind === "danger" ? "#fff" : t.accent;
  return (
    <Pressable
      accessibilityRole="button"
      {...rest}
      style={({ pressed }) => [
        {
          backgroundColor: bg,
          borderWidth: kind === "secondary" ? 1 : 0,
          borderColor: t.accent,
          paddingVertical: 10,
          paddingHorizontal: 16,
          borderRadius: 10,
          opacity: pressed || rest.disabled ? 0.6 : 1,
          alignItems: "center",
          flexDirection: "row",
          justifyContent: "center",
          gap: 8,
        },
      ]}
    >
      {loading ? <ActivityIndicator color={fg} /> : null}
      <Text style={{ color: fg, fontWeight: "600", fontSize: 15 }}>{title}</Text>
    </Pressable>
  );
}
