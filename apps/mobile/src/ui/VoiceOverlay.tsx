// Full-screen voice mode: a big tap-to-talk target (tap, speak, pause; it
// stops by itself), what you said, what it is saying, one-line activity.
// During a run it is Lab mode: the current step in large type and the short
// commands it understands. Interrupt and Close are explicit controls (a
// full-screen Pressable used to wrap everything and swallowed taps on the X;
// it also merged every child into one accessibility element).
import { useEffect } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { PttState } from "~/hooks/usePushToTalk";
import { useTheme } from "./theme";

/** The phone must not lock while Lab mode is open: iOS will not reopen the
 *  app from the Lock Screen without Face ID, which is no use with gloves on.
 *  Held only while the overlay is visible, so the phone locks as usual after. */
function useScreenAwake(on: boolean): void {
  useEffect(() => {
    if (!on) return;
    let active = false;
    void import("expo-keep-awake")
      .then((m) => m.activateKeepAwakeAsync("labee-voice"))
      .then(() => {
        active = true;
      })
      .catch(() => {});
    return () => {
      void import("expo-keep-awake")
        .then((m) => (active ? m.deactivateKeepAwake("labee-voice") : undefined))
        .catch(() => {});
    };
  }, [on]);
}

export function VoiceOverlay({
  visible,
  onClose,
  ptt,
  seconds,
  onTap,
  step,
  hints,
  heard,
  saying,
  activity,
  speaking,
  streaming,
  onInterrupt,
  error,
}: {
  visible: boolean;
  onClose: () => void;
  ptt: PttState;
  seconds: number;
  /** Start listening, or stop early if already listening. */
  onTap: () => void;
  /** Lab mode: the current step, shown large. */
  step?: string | null;
  /** Lab mode: the commands it understands. */
  hints?: string[] | null;
  heard: string | null;
  saying: string;
  activity: string | null;
  speaking: boolean;
  streaming: boolean;
  onInterrupt: () => void;
  error: string | null;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  useScreenAwake(visible);
  const phase = ptt === "recording" ? "Listening" : ptt === "transcribing" ? "Transcribing" : speaking ? "Speaking" : streaming ? "Thinking" : step ? "Lab mode" : "Tap to talk";
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen">
      <View
        accessible={false}
        style={{
          flex: 1,
          backgroundColor: t.bg,
          paddingTop: Math.max(insets.top, 12) + 8,
          paddingBottom: Math.max(insets.bottom, 12) + 8,
          paddingHorizontal: 24,
          justifyContent: "space-between",
        }}
      >
        <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close voice mode"
            testID="voice-close"
            hitSlop={20}
            style={({ pressed }) => ({
              width: 44,
              height: 44,
              borderRadius: 22,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: pressed ? t.border : t.card,
              borderWidth: 1,
              borderColor: t.border,
            })}
          >
            <Text style={{ color: t.text, fontSize: 20, lineHeight: 22 }}>✕</Text>
          </Pressable>
        </View>

        <View style={{ alignItems: "center", gap: 16 }}>
          {step ? (
            <Text testID="voice-step" style={{ color: t.text, fontSize: 22, lineHeight: 30, fontWeight: "600", textAlign: "center" }} numberOfLines={6}>
              {step}
            </Text>
          ) : null}
          <Text style={{ color: t.muted, fontSize: 13, letterSpacing: 1 }}>
            {phase.toUpperCase()}
            {ptt === "recording" ? ` · ${seconds}s` : ""}
          </Text>
          {heard ? <Text style={{ color: t.muted, fontSize: 16, textAlign: "center", fontStyle: "italic" }}>“{heard}”</Text> : null}
          <Text style={{ color: t.text, fontSize: 20, textAlign: "center", lineHeight: 28 }} numberOfLines={8}>
            {saying || (streaming ? "…" : "")}
          </Text>
          {activity ? <Text style={{ color: t.muted, fontSize: 13 }}>{activity}</Text> : null}
          {error ? <Text style={{ color: t.danger, fontSize: 13, textAlign: "center" }}>{error}</Text> : null}
          {speaking ? (
            <Pressable onPress={onInterrupt} accessibilityRole="button" testID="voice-interrupt" hitSlop={12} style={{ paddingVertical: 8, paddingHorizontal: 16, borderRadius: 999, borderWidth: 1, borderColor: t.border }}>
              <Text style={{ color: t.accent, fontSize: 14 }}>Stop speaking</Text>
            </Pressable>
          ) : null}
        </View>

        <View style={{ alignItems: "center", gap: 14 }}>
          {hints?.length ? (
            <Text testID="voice-hints" style={{ color: t.muted, fontSize: 13, textAlign: "center", lineHeight: 19 }}>
              Say: {hints.join(" · ")}
            </Text>
          ) : null}
          <Pressable
            testID="voice-mic"
            accessibilityRole="button"
            accessibilityLabel={ptt === "recording" ? "Stop listening" : "Tap to talk"}
            onPress={onTap}
            disabled={ptt === "transcribing"}
            style={{
              width: 96,
              height: 96,
              borderRadius: 48,
              backgroundColor: ptt === "recording" ? t.danger : t.accent,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ fontSize: 36 }}>{ptt === "recording" ? "●" : "🎤"}</Text>
          </Pressable>
          <Text style={{ color: t.muted, fontSize: 12 }}>{ptt === "recording" ? "listening, pause when you're done or tap to stop" : "tap, speak, then pause"}</Text>
          <Pressable onPress={onClose} accessibilityRole="button" testID="voice-done" hitSlop={12} style={{ marginTop: 6, paddingVertical: 10, paddingHorizontal: 28, borderRadius: 999, backgroundColor: t.card, borderWidth: 1, borderColor: t.border }}>
            <Text style={{ color: t.text, fontSize: 15, fontWeight: "600" }}>Done</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
