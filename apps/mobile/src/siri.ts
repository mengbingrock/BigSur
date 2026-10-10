// What the Siri intents need to call the server without the JS app running:
// the account server, the selected Mac, and the sealed session. Written
// whenever any of them changes; cleared on sign-out. The native module
// (apps/mobile/modules/labee-siri) keeps it in the Keychain so a request from
// the lock screen can read it; where the module is absent (web, an old
// build) this is a no-op.
import { Platform } from "react-native";

export interface SiriConfig {
  base: string;
  hostId: string | null;
  sessionToken: string | null;
}

interface NativeModule {
  configure(config: SiriConfig | null): Promise<void>;
  updateShortcuts(): Promise<void>;
  donate(intent: string): Promise<void>;
  startRunActivity(payloadJson: string): Promise<void>;
  syncRunActivity(payloadJson: string): Promise<void>;
  endRunActivity(runId: string): Promise<void>;
}

let native: NativeModule | null | undefined;

function module(): NativeModule | null {
  if (native !== undefined) return native;
  if (Platform.OS !== "ios") return (native = null);
  try {
    // Resolved at runtime so a build without the module still loads.
    const { requireNativeModule } = require("expo-modules-core") as { requireNativeModule: (n: string) => NativeModule };
    native = requireNativeModule("LabeeSiri");
  } catch {
    native = null;
  }
  return native;
}

export async function configureSiri(config: SiriConfig | null): Promise<void> {
  try {
    await module()?.configure(config);
  } catch {
    // never let Siri plumbing break sign-in
  }
}

export async function refreshSiriShortcuts(): Promise<void> {
  try {
    await module()?.updateShortcuts();
  } catch {
    // ignore
  }
}

export async function donateSiriIntent(intent: string): Promise<void> {
  try {
    await module()?.donate(intent);
  } catch {
    // ignore
  }
}

/** The run's Live Activity (run-design §5.3): started with the timer,
 *  kept in step with every change, ended with the run. The payload is what
 *  the app already holds, so nothing is fetched twice. */
export async function startRunActivity(payload: unknown): Promise<void> {
  try {
    await module()?.startRunActivity(JSON.stringify(payload));
  } catch {
    // ignore
  }
}

export async function syncRunActivity(payload: unknown): Promise<void> {
  try {
    await module()?.syncRunActivity(JSON.stringify(payload));
  } catch {
    // ignore
  }
}

export async function endRunActivity(runId: string): Promise<void> {
  try {
    await module()?.endRunActivity(runId);
  } catch {
    // ignore
  }
}
