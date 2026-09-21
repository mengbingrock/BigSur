// Push notifications through Expo's push service (no Apple credentials on the
// server; the app registers an ExpoPushToken). Failures are logged and ignored.
import { pushTokensFor } from "./deviceLink/devices";

const EXPO_PUSH_URL = process.env.EXPO_PUSH_URL || "https://exp.host/--/api/v2/push/send";

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export async function sendPush(email: string, msg: PushMessage): Promise<number> {
  const tokens = await pushTokensFor(email);
  if (tokens.length === 0) return 0;
  const messages = tokens.map((to) => ({ to, sound: "default", title: msg.title, body: msg.body, data: msg.data ?? {} }));
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(messages),
    });
    if (!res.ok) console.warn(`[push] expo push failed: ${res.status}`);
  } catch (e) {
    console.warn("[push] expo push error:", e instanceof Error ? e.message : e);
  }
  return tokens.length;
}
