import { useColorScheme } from "react-native";

export interface Theme {
  bg: string;
  card: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  accentText: string;
  danger: string;
  ok: string;
  warn: string;
  userBubble: string;
  mono: string;
}

const light: Theme = {
  bg: "#fafaf7",
  card: "#ffffff",
  text: "#1c1c1c",
  muted: "#6b6b66",
  border: "#e6e4dc",
  accent: "#2f5d50",
  accentText: "#ffffff",
  danger: "#b3261e",
  ok: "#2e7d32",
  warn: "#b26a00",
  userBubble: "#e8efe9",
  mono: "Menlo",
};
const dark: Theme = {
  bg: "#141413",
  card: "#1e1e1c",
  text: "#f2f1ec",
  muted: "#9a9a92",
  border: "#2c2c29",
  accent: "#7fb8a4",
  accentText: "#0f1f1a",
  danger: "#ff6b60",
  ok: "#7ed491",
  warn: "#f0b35b",
  userBubble: "#22302a",
  mono: "Menlo",
};

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
