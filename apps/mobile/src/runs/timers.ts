// Run timers on the phone (run-design §3, "Timers"): a local notification
// scheduled for the end, time-sensitive so AirPods announce it and it breaks
// through Focus, with the run's buttons. Scheduled by whoever starts the
// timer here; cancelled when the run cancels it. Survives the app being
// killed because iOS holds the schedule.
import { Platform } from "react-native";
import type { RunTimer } from "~/api/runs";
import { CATEGORY } from "~/notifications/categories";

const ids = new Map<string, string>();

export async function scheduleTimerNotification(run: { id: string; sessionId: string; protocolName: string }, timer: RunTimer): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    const Notifications = await import("expo-notifications");
    const date = new Date(timer.endsAt);
    if (date.getTime() <= Date.now()) return;
    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title: `${timer.label} timer done`,
        body: `${run.protocolName} · step ${timer.step}`,
        sound: "default",
        categoryIdentifier: CATEGORY.timer,
        interruptionLevel: "timeSensitive",
        data: { kind: "timer", runId: run.id, sessionId: run.sessionId, step: timer.step, timerId: timer.id },
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date },
    });
    ids.set(timer.id, id);
  } catch {
    // Notifications denied or unavailable: the timer still counts down on screen.
  }
}

export async function cancelTimerNotification(timerId: string): Promise<void> {
  const id = ids.get(timerId);
  if (!id) return;
  ids.delete(timerId);
  try {
    const Notifications = await import("expo-notifications");
    await Notifications.cancelScheduledNotificationAsync(id);
  } catch {
    // ignore
  }
}
