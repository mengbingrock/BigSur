// Push registration (native only), the notification categories with their
// buttons (docs/siri-design.md §4), and what happens when a button is
// pressed: answer the agent, send a reply, mark a step done — without
// opening the app where the action allows it.
import { Platform } from "react-native";
import type { Target } from "~/api/client";
import { registerPushToken } from "~/api/link";
import { runAction } from "~/api/runs";
import { answerSpoken, startTurn } from "~/api/sessions";
import { categoryActions, decide, type PushData } from "~/notifications/categories";

/** Re-send the push token on every launch, without prompting: the token can
 *  change, and the server's record of it can be lost (it was, for every
 *  phone signed in with Apple or Google, until the server accepted them). */
export const syncPushRegistration = (target: Target) => registerForPush(target, { prompt: false });

export async function registerForPush(target: Target, opts: { prompt?: boolean } = {}): Promise<string | null> {
  if (Platform.OS === "web") return null;
  try {
    const Notifications = await import("expo-notifications");
    const Device = await import("expo-device");
    if (!Device.isDevice) return null;
    const perm = await Notifications.getPermissionsAsync();
    let status = perm.status;
    if (status !== "granted" && opts.prompt !== false) status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== "granted") return null;
    await registerCategories();
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

async function registerCategories(): Promise<void> {
  const Notifications = await import("expo-notifications");
  for (const [id, actions] of Object.entries(categoryActions())) {
    await Notifications.setNotificationCategoryAsync(
      id,
      actions.map((a) => ({
        identifier: a.identifier,
        buttonTitle: a.buttonTitle,
        ...(a.textInput ? { textInput: a.textInput } : {}),
        options: { opensAppToForeground: Boolean(a.opensApp || a.textInput === undefined && a.identifier === "open") },
      })),
    );
  }
}

/** A push that lands while the app is open is spoken by the phone (the
 *  device day: a return from a chat that only buzzed). iOS shows it as a
 *  banner too. Siri cannot speak unprompted; Announce Notifications on
 *  AirPods covers the locked phone, this covers the phone in hand. */
export async function handleNotificationsReceived(): Promise<() => void> {
  if (Platform.OS === "web") return () => {};
  try {
    const Notifications = await import("expo-notifications");
    const { speakAloud } = await import("~/speak");
    const sub = Notifications.addNotificationReceivedListener((n) => {
      const content = n.request.content;
      const data = (content.data ?? {}) as PushData & { origin?: string };
      const spoken = ["question", "done", "error", "timer"].includes(String(data.kind ?? "")) || data.origin === "siri";
      if (!spoken) return;
      const title = content.title ? `${content.title}: ` : "";
      void speakAloud(`${title}${content.body ?? ""}`);
    });
    return () => sub.remove();
  } catch {
    return () => {};
  }
}

/** Target for a push that names the Mac holding the session. */
function targetFor(base: string, hostId?: string): Target {
  return hostId ? { base, hostId } : { base };
}

/** Wire the response listener once. `open` navigates; the rest is network. */
export async function handleNotificationResponses(
  base: string,
  open: (path: string) => void,
): Promise<() => void> {
  if (Platform.OS === "web") return () => {};
  try {
    const Notifications = await import("expo-notifications");
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const content = response.notification.request.content;
      const data = (content.data ?? {}) as PushData;
      const text = (response as { userText?: string }).userText;
      const d = decide(content.categoryIdentifier ?? null, response.actionIdentifier, data, text);
      void (async () => {
        switch (d.do) {
          case "answer":
            await answerSpoken(targetFor(base, d.hostId), d.sessionId, d.spoken).catch(() => open(`/session/${d.sessionId}`));
            return;
          case "reply":
            await startTurn(targetFor(base, d.hostId), d.sessionId, { text: d.text, device: "iPhone", voice: true }).catch(() => open(`/session/${d.sessionId}`));
            return;
          case "open-session":
            open(`/session/${d.sessionId}${d.voice ? "?voice=1" : ""}`);
            return;
          case "run-advance":
            await runAction({ base }, d.runId, "advance", { device: "iPhone" }).catch(() => {});
            return;
          case "run-timer":
            await runAction({ base }, d.runId, "timer", { device: "iPhone", seconds: d.seconds, label: d.label }).catch(() => {});
            return;
          case "open-run":
            if (d.sessionId) open(`/session/${d.sessionId}`);
            return;
          default:
            return;
        }
      })();
    });
    return () => sub.remove();
  } catch {
    return () => {};
  }
}
