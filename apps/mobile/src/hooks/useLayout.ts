import { useWindowDimensions } from "react-native";

/** iPad / wide layouts get side-by-side panes. */
export function useWide(): boolean {
  const { width } = useWindowDimensions();
  return width >= 768;
}
