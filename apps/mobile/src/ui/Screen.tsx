import type { ReactNode } from "react";
import { View, type ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "./theme";

export function Screen({ children, style, edges }: { children: ReactNode; style?: ViewStyle; edges?: ("top" | "bottom" | "left" | "right")[] }) {
  const t = useTheme();
  return (
    <SafeAreaView edges={edges ?? ["left", "right", "bottom"]} style={[{ flex: 1, backgroundColor: t.bg }, style]}>
      <View style={{ flex: 1 }}>{children}</View>
    </SafeAreaView>
  );
}
