// Notification categories (docs/siri-design.md §4) as plain data, so the
// registration and the response handling are tested without a device.
//
//   labee.question   the agent asked: one button per option (max 4) + Open
//   labee.reply      a turn finished: Reply (text input) · Read in Labee
//   labee.attention  an error, or the Mac is needed: Open
//   labee.timer      a run timer ended: Done with step · Five more minutes

export const CATEGORY = {
  question: "labee.question",
  reply: "labee.reply",
  attention: "labee.attention",
  timer: "labee.timer",
} as const;

export interface ActionSpec {
  identifier: string;
  buttonTitle: string;
  textInput?: { submitButtonTitle: string; placeholder: string };
  opensApp?: boolean;
}

/** The static part of each category. Question options are dynamic: iOS
 *  categories are fixed at registration, so the question category carries
 *  four generic option slots whose titles the push cannot change; the
 *  handler maps slot → option by index from the push data. */
export function categoryActions(): Record<string, ActionSpec[]> {
  return {
    [CATEGORY.question]: [
      { identifier: "opt1", buttonTitle: "Option 1" },
      { identifier: "opt2", buttonTitle: "Option 2" },
      { identifier: "opt3", buttonTitle: "Option 3" },
      { identifier: "open", buttonTitle: "Open", opensApp: true },
    ],
    [CATEGORY.reply]: [
      { identifier: "reply", buttonTitle: "Reply", textInput: { submitButtonTitle: "Send", placeholder: "Message" } },
      { identifier: "open-voice", buttonTitle: "Read in Labee", opensApp: true },
    ],
    [CATEGORY.attention]: [{ identifier: "open", buttonTitle: "Open", opensApp: true }],
    [CATEGORY.timer]: [
      { identifier: "done", buttonTitle: "Done with step" },
      { identifier: "snooze", buttonTitle: "Five more minutes" },
    ],
  };
}

export interface PushData {
  kind?: string;
  sessionId?: string;
  hostId?: string;
  runId?: string;
  step?: number;
  timerId?: string;
  /** Option labels of the first question, in order. */
  options?: string[];
}

export type Decision =
  | { do: "answer"; sessionId: string; hostId?: string; spoken: string }
  | { do: "reply"; sessionId: string; hostId?: string; text: string }
  | { do: "open-session"; sessionId: string; voice: boolean }
  | { do: "run-advance"; runId: string }
  | { do: "run-timer"; runId: string; seconds: number; label: string }
  | { do: "open-run"; runId: string; sessionId?: string }
  | { do: "none" };

/** What to do with a notification response. `action` is the pressed button
 *  (or the default-open identifier), `text` the typed reply if any. */
export function decide(category: string | null, action: string, data: PushData, text?: string): Decision {
  const defaultOpen = action === "expo.modules.notifications.actions.DEFAULT" || action === "default";
  if (category === CATEGORY.question) {
    const m = action.match(/^opt(\d)$/);
    if (m && data.sessionId) {
      const label = data.options?.[Number(m[1]) - 1];
      if (label) return { do: "answer", sessionId: data.sessionId, ...(data.hostId ? { hostId: data.hostId } : {}), spoken: label };
    }
    if (data.sessionId) return { do: "open-session", sessionId: data.sessionId, voice: false };
    return { do: "none" };
  }
  if (category === CATEGORY.reply) {
    if (action === "reply" && text?.trim() && data.sessionId) {
      return { do: "reply", sessionId: data.sessionId, ...(data.hostId ? { hostId: data.hostId } : {}), text: text.trim() };
    }
    if (data.sessionId) return { do: "open-session", sessionId: data.sessionId, voice: action === "open-voice" };
    return { do: "none" };
  }
  if (category === CATEGORY.timer) {
    if (!data.runId) return { do: "none" };
    if (action === "done") return { do: "run-advance", runId: data.runId };
    if (action === "snooze") return { do: "run-timer", runId: data.runId, seconds: 300, label: "5 more minutes" };
    return { do: "open-run", runId: data.runId, ...(data.sessionId ? { sessionId: data.sessionId } : {}) };
  }
  if (data.sessionId && (defaultOpen || action === "open")) return { do: "open-session", sessionId: data.sessionId, voice: false };
  return { do: "none" };
}

/** Button titles for a question push are generic; the body carries the real
 *  options so the person can read them before pressing. */
export function questionBody(question: string, options: string[]): string {
  const opts = options.slice(0, 3).map((o, i) => `${i + 1}. ${o}`).join("  ");
  return opts ? `${question}\n${opts}` : question;
}
