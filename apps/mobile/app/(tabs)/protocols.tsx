// The protocol library on a phone: browse what you own, search it, or ask a
// question and get an answer drawn only from your own protocols, with the
// passages it used. Reads whichever machine is selected under Settings ›
// Devices, so these are the protocols on that Mac.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  askProtocols,
  indexStatus,
  isLibrarySlug,
  libraryIdOf,
  listProtocols,
  searchProtocols,
  whereLabel,
  type AskResult,
  type IndexStatus,
  type Protocol,
  type Scope,
  type SearchHit,
} from "~/api/protocols";
import { useApp } from "~/state/AppContext";
import { Button } from "~/ui/Button";
import { Chip } from "~/ui/Chip";
import { Screen } from "~/ui/Screen";
import { useTheme } from "~/ui/theme";

const UNCATEGORISED = "Uncategorised";

export default function ProtocolsScreen() {
  const t = useTheme();
  const router = useRouter();
  const { target } = useApp();
  const [all, setAll] = useState<Protocol[]>([]);
  const [q, setQ] = useState("");
  // Which pool search and Ask look in: own protocols, the shared library on
  // labee.online, or both. "Mine" is the quiet way to say "my protocols only".
  const [scope, setScope] = useState<Scope>("mine");
  const [libraryReachable, setLibraryReachable] = useState(true);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [mode, setMode] = useState<"semantic" | "lexical" | null>(null);
  const [index, setIndex] = useState<IndexStatus | null>(null);
  const [searching, setSearching] = useState(false);
  const [answer, setAnswer] = useState<AskResult | null>(null);
  const [asking, setAsking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Only the newest search may write results: a slow earlier one must not
  // overwrite what the user is looking at now.
  const searchSeq = useRef(0);

  const load = useCallback(async () => {
    try {
      setAll(await listProtocols(target));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [target]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // Search as you type, once typing settles.
  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setHits(null);
      setSearching(false);
      return;
    }
    const seq = ++searchSeq.current;
    setSearching(true);
    const id = setTimeout(async () => {
      try {
        const r = await searchProtocols(target, query, scope);
        if (seq === searchSeq.current) {
          setHits(r.hits);
          setMode(r.mode);
          setLibraryReachable(r.libraryReachable !== false);
        }
      } catch (e) {
        if (seq === searchSeq.current) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    }, 300);
    return () => clearTimeout(id);
  }, [q, scope, target]);

  // Search quality depends on the embedding pass finishing, so say so while it
  // runs. Poll only until it is done.
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const st = await indexStatus(target);
        if (stop) return;
        setIndex(st);
        if (st.available && st.indexed < st.total) setTimeout(tick, 2000);
      } catch {
        // a notice is not worth surfacing an error for
      }
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [target]);

  const ask = async () => {
    const question = q.trim();
    if (!question) return;
    setAsking(true);
    setAnswer(null);
    try {
      setAnswer(await askProtocols(target, question, scope));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setAsking(false);
    }
  };

  const bySlug = useMemo(() => new Map(all.map((p) => [p.slug, p])), [all]);
  const groups = useMemo(() => {
    const m = new Map<string, Protocol[]>();
    for (const p of all) {
      const key = p.category?.trim() || UNCATEGORISED;
      m.set(key, [...(m.get(key) ?? []), p]);
    }
    return [...m.entries()].sort((a, b) =>
      a[0] === UNCATEGORISED ? 1 : b[0] === UNCATEGORISED ? -1 : a[0].localeCompare(b[0]),
    );
  }, [all]);

  // A library hit opens the same screen, which reads it from the library.
  const open = (slug: string) =>
    router.push(`/protocol/${encodeURIComponent(isLibrarySlug(slug) ? `library:${libraryIdOf(slug)}` : slug)}`);

  const Row = ({ p, sub }: { p: Protocol; sub?: string }) => (
    <Pressable
      onPress={() => open(p.slug)}
      style={{ paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: t.border, gap: 3 }}
    >
      <Text numberOfLines={1} style={{ color: t.text, fontSize: 15, fontWeight: "600" }}>
        {p.name}
      </Text>
      <Text numberOfLines={2} style={{ color: t.muted, fontSize: 12 }}>
        {sub || p.description || p.category || ""}
      </Text>
    </Pressable>
  );

  return (
    <Screen>
      <View style={{ padding: 12, gap: 8, borderBottomWidth: 1, borderBottomColor: t.border }}>
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search protocols, or ask a question"
          placeholderTextColor={t.muted}
          autoCapitalize="none"
          returnKeyType="search"
          style={{ borderWidth: 1, borderColor: t.border, borderRadius: 8, padding: 10, color: t.text, backgroundColor: t.card }}
        />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {(["mine", "library", "all"] as Scope[]).map((s) => (
            <Pressable key={s} onPress={() => setScope(s)} hitSlop={6}>
              <Chip label={s === "mine" ? "Mine" : s === "library" ? "Library" : "Both"} tone={scope === s ? "accent" : "muted"} />
            </Pressable>
          ))}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Button title={asking ? "Asking…" : scope === "mine" ? "Ask my protocols" : scope === "library" ? "Ask the library" : "Ask both"} onPress={ask} disabled={!q.trim() || asking} />
          {q ? <Button kind="ghost" title="Clear" onPress={() => { setQ(""); setAnswer(null); }} /> : null}
          {searching ? <ActivityIndicator color={t.muted} /> : null}
        </View>
      </View>

      <ScrollView keyboardShouldPersistTaps="handled">
        {err ? (
          <View style={{ padding: 16, gap: 4 }}>
            <Text style={{ color: t.danger }}>{err}</Text>
            {/^This Mac is offline/i.test(err) ? (
              <Text style={{ color: t.muted, fontSize: 12 }}>
                Protocols live on the machine that holds them. Wake that Mac, or pick another under Settings › Devices.
              </Text>
            ) : null}
          </View>
        ) : null}

        {!libraryReachable && scope !== "mine" ? (
          <Text style={{ color: t.muted, fontSize: 12, paddingHorizontal: 16, paddingTop: 12 }}>
            The library on labee.online could not be reached — showing your protocols only.
          </Text>
        ) : null}
        {index && index.available && index.indexed < index.total ? (
          <Text style={{ color: t.muted, fontSize: 12, paddingHorizontal: 16, paddingTop: 12 }}>
            Indexing {index.indexed} of {index.total} for search — results improve as it finishes.
          </Text>
        ) : mode === "lexical" && hits ? (
          <Text style={{ color: t.muted, fontSize: 12, paddingHorizontal: 16, paddingTop: 12 }}>
            Matching on words only. Meaning-based search needs a model account on that machine.
          </Text>
        ) : null}

        {answer ? (
          <View style={{ padding: 16, gap: 10, borderBottomWidth: 1, borderBottomColor: t.border, backgroundColor: t.card }}>
            <Chip label={scope === "mine" ? "answered from your protocols" : scope === "library" ? "answered from the library" : "answered from your protocols and the library"} tone="accent" />
            {answer.available ? (
              <>
                <Text selectable style={{ color: t.text, fontSize: 15, lineHeight: 21 }}>
                  {answer.answer}
                </Text>
                {answer.confidence !== null ? (
                  <Text style={{ color: answer.confidence < 0.5 ? t.danger : t.muted, fontSize: 12 }}>
                    {answer.confidence < 0.5 ? `Low confidence (${Math.round(answer.confidence * 100)}%) — check the source` : `Confidence ${Math.round(answer.confidence * 100)}%`}
                  </Text>
                ) : null}
              </>
            ) : (
              <Text style={{ color: t.muted, fontSize: 13 }}>
                Answering needs a model account on the machine holding these protocols. Set one under Settings › Connection.
              </Text>
            )}
            {answer.citations.map((c) => (
              <Pressable key={`${c.n}:${c.slug}`} onPress={() => open(c.slug)} style={{ gap: 2 }}>
                <Text style={{ color: t.accent, fontSize: 12, fontWeight: "700" }}>
                  [{c.n}] {c.name}
                  {whereLabel(c) ? ` · ${whereLabel(c)}` : ""}
                  {c.pool === "library" ? ` · library${c.license ? ` · ${c.license}` : ""}` : ""}
                </Text>
                <Text numberOfLines={3} style={{ color: t.muted, fontSize: 12, fontStyle: "italic" }}>
                  {c.quote}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {hits ? (
          hits.length === 0 && !searching ? (
            <Text style={{ color: t.muted, padding: 24, textAlign: "center" }}>
              Nothing matched “{q.trim()}”. Try “Ask my protocols”.
            </Text>
          ) : (
            hits.map((h) => {
              if (h.pool === "library") {
                return (
                  <Pressable
                    key={h.slug}
                    onPress={() => open(h.slug)}
                    style={{ paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: t.border, gap: 3 }}
                  >
                    <Text numberOfLines={1} style={{ color: t.text, fontSize: 15, fontWeight: "600" }}>{h.name}</Text>
                    <Text style={{ color: t.muted, fontSize: 11 }}>
                      Library · {h.source}{h.license ? ` · ${h.license}` : ""}{whereLabel(h) ? ` · ${whereLabel(h)}` : ""}
                    </Text>
                    <Text numberOfLines={2} style={{ color: t.muted, fontSize: 12 }}>{h.snippet}</Text>
                  </Pressable>
                );
              }
              const p = bySlug.get(h.slug);
              return p ? <Row key={h.slug} p={p} sub={[whereLabel(h), h.snippet || p.description].filter(Boolean).join(" — ")} /> : null;
            })
          )
        ) : (
          groups.map(([category, items]) => (
            <View key={category}>
              <Text style={{ color: t.muted, fontSize: 12, paddingHorizontal: 16, paddingTop: 18, paddingBottom: 6 }}>
                {category.toUpperCase()} · {items.length}
              </Text>
              {items.map((p) => (
                <Row key={p.slug} p={p} />
              ))}
            </View>
          ))
        )}

        {!hits && all.length === 0 && !err ? (
          <Text style={{ color: t.muted, padding: 24, textAlign: "center" }}>
            No protocols on this machine yet.
          </Text>
        ) : null}
        <View style={{ height: 32 }} />
      </ScrollView>
    </Screen>
  );
}
