// One protocol, read-only: its steps as written on the machine that holds it —
// or, for a "library:<id>" slug, in the shared library on labee.online, with
// a button to save a copy. One's own protocol also shows the mechanical
// checks and can be reviewed step by step. Plain text with monospace fences,
// the same treatment as a chat message — the app carries no markdown renderer.
import { useCallback, useEffect, useState } from "react";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Linking, ScrollView, Text, View } from "react-native";
import {
  getLibraryProtocol,
  getProtocol,
  libraryIdOf,
  lintProtocol,
  reviewProtocol,
  saveFromLibrary,
  type LibraryProtocol,
  type LintFinding,
  type Protocol,
  type ReviewFinding,
} from "~/api/protocols";
import { createSession } from "~/api/sessions";
import { useApp } from "~/state/AppContext";
import { Button } from "~/ui/Button";
import { Chip } from "~/ui/Chip";
import { Screen } from "~/ui/Screen";
import { useTheme } from "~/ui/theme";

export default function ProtocolScreen() {
  const t = useTheme();
  const router = useRouter();
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { target } = useApp();
  const fromLibrary = Boolean(slug && slug.startsWith("library:"));
  const [p, setP] = useState<Protocol | null>(null);
  const [lib, setLib] = useState<LibraryProtocol | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "chat" | "save" | "review">("");
  const [saved, setSaved] = useState<{ slug: string; already: boolean } | null>(null);
  const [lint, setLint] = useState<{ findings: LintFinding[]; halts: number; warns: number } | null>(null);
  const [review, setReview] = useState<{ findings: ReviewFinding[]; steps: number; available: boolean } | null>(null);

  const load = useCallback(async () => {
    if (!slug) return;
    try {
      if (fromLibrary) {
        setLib((await getLibraryProtocol(target, libraryIdOf(slug))).protocol);
      } else {
        const r = await getProtocol(target, slug);
        setP(r.skill);
        // Mechanical, instant, so it runs on open.
        lintProtocol(target, slug).then(setLint).catch(() => setLint(null));
      }
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [slug, target, fromLibrary]);
  useEffect(() => {
    void load();
  }, [load]);

  // Carry the protocol into a chat: the session opens with it attached, so the
  // first question is answered against these steps.
  const discuss = async () => {
    if (!p) return;
    setBusy("chat");
    try {
      const r = await createSession(target, { title: p.name });
      router.push(`/session/${r.session.id}?skill=${encodeURIComponent(p.slug)}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const save = async () => {
    if (!lib) return;
    setBusy("save");
    try {
      const r = await saveFromLibrary(target, lib.id);
      setSaved({ slug: r.skill.slug, already: r.already });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const runReview = async () => {
    if (!p) return;
    setBusy("review");
    try {
      setReview(await reviewProtocol(target, p.slug));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const name = p?.name ?? lib?.title ?? "Protocol";
  const description = p?.description ?? lib?.description ?? "";
  const body = p?.body ?? lib?.body ?? "";
  const purpose = p ?? lib;

  return (
    <Screen>
      <Stack.Screen options={{ title: name }} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {err ? <Text style={{ color: t.danger }}>{err}</Text> : null}
        {p || lib ? (
          <>
            <Text style={{ color: t.text, fontSize: 20, fontWeight: "700" }}>{name}</Text>
            {description ? <Text style={{ color: t.muted, fontSize: 14 }}>{description}</Text> : null}
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              {(p?.category ?? lib?.category) ? <Chip label={(p?.category ?? lib?.category)!} /> : null}
              {lib ? <Chip label={`library · ${lib.source}`} tone="accent" /> : <Chip label={p!.sourceLabel} tone="accent" />}
              {lib?.license ? <Chip label={lib.license} /> : null}
              {p?.origin?.kind === "library" ? <Chip label={`saved from the library${p.origin.license ? ` · ${p.origin.license}` : ""}`} /> : null}
              {lint && lint.halts > 0 ? <Chip label={`${lint.halts} must fix`} tone="danger" /> : null}
              {lint && lint.halts === 0 && lint.warns > 0 ? <Chip label={`${lint.warns} to look at`} tone="warn" /> : null}
            </View>

            {purpose && (purpose.problem || purpose.method || purpose.application) ? (
              <View style={{ gap: 4, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: t.border }}>
                {purpose.problem ? <Text style={{ color: t.text, fontSize: 13 }}><Text style={{ color: t.muted }}>Problem </Text>{purpose.problem}</Text> : null}
                {purpose.method ? <Text style={{ color: t.text, fontSize: 13 }}><Text style={{ color: t.muted }}>Method </Text>{purpose.method}</Text> : null}
                {purpose.application ? <Text style={{ color: t.text, fontSize: 13 }}><Text style={{ color: t.muted }}>Use it for </Text>{purpose.application}</Text> : null}
              </View>
            ) : null}

            {lib ? (
              <View style={{ gap: 8 }}>
                {saved ? (
                  <Text style={{ color: t.text, fontSize: 14 }}>
                    {saved.already ? "Already in your protocols." : "Saved to your protocols."}{" "}
                    <Text style={{ color: t.accent }} onPress={() => router.replace(`/protocol/${encodeURIComponent(saved.slug)}`)}>
                      Open your copy
                    </Text>
                  </Text>
                ) : (
                  <Button title={busy === "save" ? "Saving…" : "Save to my protocols"} onPress={save} disabled={busy !== ""} />
                )}
                {lib.sourceUrl ? (
                  <Text style={{ color: t.accent, fontSize: 13 }} onPress={() => void Linking.openURL(lib.sourceUrl)}>
                    Source: {lib.sourceUrl}
                  </Text>
                ) : null}
              </View>
            ) : (
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Button title={busy === "chat" ? "Opening…" : "Ask about this"} onPress={discuss} disabled={busy !== ""} />
                <Button kind="secondary" title={busy === "review" ? "Reviewing…" : "Review steps"} onPress={runReview} disabled={busy !== ""} />
              </View>
            )}

            {lint && lint.findings.length > 0 ? (
              <View style={{ gap: 4 }}>
                {lint.findings.map((f, i) => (
                  <Text key={`${f.ruleId}-${i}`} style={{ color: f.severity === "halt" ? t.danger : t.muted, fontSize: 12 }}>
                    {f.path || "file"} · {f.message}
                  </Text>
                ))}
              </View>
            ) : null}

            {review ? (
              <View style={{ gap: 6, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: t.border }}>
                {!review.available ? (
                  <Text style={{ color: t.muted, fontSize: 13 }}>Reviewing needs a model account on the machine holding this protocol.</Text>
                ) : review.findings.length === 0 ? (
                  <Text style={{ color: t.muted, fontSize: 13 }}>{review.steps} steps reviewed against your other protocols — nothing found.</Text>
                ) : (
                  review.findings.map((f, i) => (
                    <View key={`${f.path}-${i}`} style={{ gap: 2 }}>
                      <Text style={{ color: t.text, fontSize: 13 }}>
                        <Text style={{ color: t.muted }}>{f.path} · {f.class} · </Text>
                        {f.message}
                        {f.suggestion ? <Text style={{ color: t.muted }}> → {f.suggestion}</Text> : null}
                      </Text>
                      <Text numberOfLines={1} style={{ color: t.muted, fontSize: 11 }}>“{f.excerpt}”</Text>
                    </View>
                  ))
                )}
              </View>
            ) : null}

            <Body text={body} />
          </>
        ) : !err ? (
          <Text style={{ color: t.muted }}>Loading…</Text>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

/** Plain-text rendering with monospace code fences, as in MessageBubble. */
function Body({ text }: { text: string }) {
  const t = useTheme();
  const parts = text.split(/```/);
  return (
    <View style={{ gap: 8, paddingTop: 4 }}>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <Text
            key={i}
            selectable
            style={{ color: t.text, fontFamily: t.mono, fontSize: 12, backgroundColor: "rgba(127,127,127,0.12)", padding: 8, borderRadius: 6 }}
          >
            {part.replace(/^[a-z]*\n/, "")}
          </Text>
        ) : part.trim() ? (
          <Text key={i} selectable style={{ color: t.text, fontSize: 15, lineHeight: 22 }}>
            {part.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/^#+\s*/gm, "").trim()}
          </Text>
        ) : null,
      )}
    </View>
  );
}
