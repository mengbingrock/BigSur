// Text input + hold-to-talk mic + stop. Tap the mic (no hold) to open the
// full-screen voice mode. Read-aloud toggle lives here too.
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import type { PttState } from "~/hooks/usePushToTalk";
import { useTheme } from "./theme";

export function Composer({
  onSend,
  onStop,
  streaming,
  ptt,
  onPttStart,
  onPttStop,
  onOpenVoice,
  readAloud,
  onToggleReadAloud,
  queued,
  disabled,
  error,
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  streaming: boolean;
  ptt: PttState;
  onPttStart: () => void;
  onPttStop: () => void;
  onOpenVoice: () => void;
  readAloud: boolean;
  onToggleReadAloud: () => void;
  queued: number;
  disabled?: boolean;
  /** Last microphone / transcription error, shown under the input. */
  error?: string | null;
}) {
  const t = useTheme();
  const [text, setText] = useState("");
  const send = () => {
    const v = text.trim();
    if (!v) return;
    onSend(v);
    setText("");
  };
  const recording = ptt === "recording";
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: t.border, padding: 8, gap: 6, backgroundColor: t.bg }}>
      {queued > 0 ? (
        <Text style={{ color: t.muted, fontSize: 12 }}>
          {queued} message{queued === 1 ? "" : "s"} queued behind the running turn
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
        <TextInput
          testID="composer-input"
          value={text}
          onChangeText={setText}
          placeholder={recording ? "Listening…" : ptt === "transcribing" ? "Transcribing…" : "Message"}
          placeholderTextColor={t.muted}
          multiline
          editable={!disabled}
          onSubmitEditing={send}
          blurOnSubmit
          style={{ flex: 1, minHeight: 40, maxHeight: 120, borderWidth: 1, borderColor: t.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, color: t.text, backgroundColor: t.card }}
        />
        <Pressable
          testID="mic"
          accessibilityLabel="Hold to talk"
          disabled={disabled}
          onPressIn={onPttStart}
          onPressOut={onPttStop}
          onLongPress={() => {}}
          delayLongPress={200}
          style={({ pressed }) => ({
            width: 44,
            height: 44,
            borderRadius: 22,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: recording || pressed ? t.danger : t.card,
            borderWidth: 1,
            borderColor: recording ? t.danger : t.border,
          })}
        >
          <Text style={{ fontSize: 18 }}>{recording ? "●" : "🎤"}</Text>
        </Pressable>
        {text.trim() ? (
          <Pressable testID="send" onPress={send} disabled={disabled} style={{ height: 44, paddingHorizontal: 14, borderRadius: 22, backgroundColor: t.accent, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: t.accentText, fontWeight: "700" }}>Send</Text>
          </Pressable>
        ) : streaming ? (
          <Pressable testID="stop" onPress={onStop} style={{ height: 44, paddingHorizontal: 14, borderRadius: 22, borderWidth: 1, borderColor: t.danger, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: t.danger, fontWeight: "700" }}>⏹ Stop</Text>
          </Pressable>
        ) : null}
      </View>
      {error ? (
        <Text testID="composer-error" style={{ color: t.danger, fontSize: 12 }}>
          {error}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", gap: 12 }}>
        <Pressable onPress={onOpenVoice}>
          <Text style={{ color: t.accent, fontSize: 12 }}>Voice mode</Text>
        </Pressable>
        <Pressable onPress={onToggleReadAloud} testID="read-aloud">
          <Text style={{ color: readAloud ? t.accent : t.muted, fontSize: 12 }}>{readAloud ? "🔊 Read aloud on" : "🔇 Read aloud off"}</Text>
        </Pressable>
      </View>
    </View>
  );
}
