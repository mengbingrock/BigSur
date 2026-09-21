// Push registration (native only). The token goes to the box, which relays
// question/gate/turn-end pushes through Expo's push service.
import { Platform } from "react-native";
import type { Target } from "~/api/client";
import { registerPushToken } from "~/api/link";

export async function registerForPush(target: Target): Promise<string | null> {
  if (Platform.OS === "web") return null;
  try {
    const Notifications = await import("expo-notifications");
    const Device = await import("expo-device");
    if (!Device.isDevice) return null;
    const perm = await Notifications.getPermissionsAsync();
    let status = perm.status;
    if (status !== "granted") status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== "granted") return null;
    const token = (await Notifications.getExpoPushTokenAsync()).data;
    await registerPushToken({ base: target.base }, token).catch(() => {});
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
    return token;
  } catch {
    return null;
  }
}
