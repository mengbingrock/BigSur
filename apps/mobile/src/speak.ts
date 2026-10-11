// Speaking to the person without Siri (siri-agent design §5, the device
// day): iOS reads a notification aloud only through Announce Notifications
// on AirPods or CarPlay. Everywhere else, the app has to say it itself, and
// it can only do that while it is running. So: a return from a chat, a
// question it asks, a timer that ends — spoken by the phone's own voice when
// the app is open, unless the person turned it off in Settings.
import { Platform } from "react-native";
import { getPref } from "~/storage";

export const SPEAK_PREF = "labee:speakReturns";

let cached: boolean | null = null;

export async function speakingEnabled(): Promise<boolean> {
  if (cached !== null) return cached;
  const v = await getPref(SPEAK_PREF).catch(() => null);
  cached = v !== "0"; // on until turned off
  return cached;
}

export function setSpeakingEnabled(on: boolean): void {
  cached = on;
}

/** Say it now, interrupting nothing: a return never cuts off a reply that
 *  is already being read. */
export async function speakAloud(text: string): Promise<void> {
  if (Platform.OS === "web") return;
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return;
  if (!(await speakingEnabled())) return;
  try {
    const Speech = await import("expo-speech");
    if (await Speech.isSpeakingAsync()) {
      // Queue behind what is being said; expo-speech speaks sequentially.
    }
    Speech.speak(t, { rate: 1.0 });
  } catch {
    // no voice available: the notification is still on screen
  }
}

/** The spoken form of a question with its options: "Which ladder? One
 *  kilobase, or one hundred base pair?" */
export function spokenQuestion(question: string, options: string[]): string {
  const q = question.trim().replace(/[.?!]*$/, "");
  const opts = options.filter(Boolean).slice(0, 4);
  if (opts.length === 0) return `${q}?`;
  if (opts.length === 1) return `${q}? ${opts[0]}?`;
  return `${q}? ${opts.slice(0, -1).join(", ")}, or ${opts[opts.length - 1]}?`;
}
