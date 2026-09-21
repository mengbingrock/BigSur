// Full-screen voice mode: big hold-to-talk target, what you said, what it is
// saying, one-line activity. Interrupt and Close are explicit controls (a
// full-screen Pressable used to wrap everything and swallowed taps on the X;
// it also merged every child into one accessibility element).
import { Modal, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { PttState } from "~/hooks/usePushToTalk";
import { useTheme } from "./theme";

export function VoiceOverlay({
  visible,
  onClose,
  ptt,
  seconds,
  onPttStart,
  onPttStop,
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
  onPttStart: () => void;
  onPttStop: () => void;
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
  const phase = ptt === "recording" ? "Listening" : ptt === "transcribing" ? "Transcribing" : speaking ? "Speaking" : streaming ? "Thinking" : "Hold to talk";
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
          <Pressable
            testID="voice-mic"
            accessibilityRole="button"
            accessibilityLabel="Hold to talk"
            onPressIn={onPttStart}
            onPressOut={onPttStop}
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
          <Text style={{ color: t.muted, fontSize: 12 }}>hold the mic while speaking</Text>
          <Pressable onPress={onClose} accessibilityRole="button" testID="voice-done" hitSlop={12} style={{ marginTop: 6, paddingVertical: 10, paddingHorizontal: 28, borderRadius: 999, backgroundColor: t.card, borderWidth: 1, borderColor: t.border }}>
            <Text style={{ color: t.text, fontSize: 15, fontWeight: "600" }}>Done</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
