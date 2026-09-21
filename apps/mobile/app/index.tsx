import { Redirect } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { useApp } from "~/state/AppContext";

export default function Index() {
  const { ready, user } = useApp();
  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }
  return <Redirect href={user ? "/(tabs)" : "/sign-in"} />;
}
