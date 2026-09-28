// The protocol library on a phone: browse what you own, search it, or ask a
// question and get an answer drawn only from your own protocols, with the
// passages it used. Reads whichever machine is selected under Settings ›
// Devices, so these are the protocols on that Mac.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  askProtocols,
  listProtocols,
  indexStatus,
  searchProtocols,
  type AskResult,
  type IndexStatus,
  type Protocol,
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
        const r = await searchProtocols(target, query);
        if (seq === searchSeq.current) {
          setHits(r.hits);
          setMode(r.mode);
        }
      } catch (e) {
        if (seq === searchSeq.current) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    }, 300);
    return () => clearTimeout(id);
  }, [q, target]);

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
      setAnswer(await askProtocols(target, question));
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

  const open = (slug: string) => router.push(`/protocol/${encodeURIComponent(slug)}`);

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
          <Button title={asking ? "Asking…" : "Ask my protocols"} onPress={ask} disabled={!q.trim() || asking} />
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
            <Chip label="answered from your protocols" tone="accent" />
            {answer.available ? (
              <Text selectable style={{ color: t.text, fontSize: 15, lineHeight: 21 }}>
                {answer.answer}
              </Text>
            ) : (
              <Text style={{ color: t.muted, fontSize: 13 }}>
                Answering needs a model account on the machine holding these protocols. Set one under Settings › Connection.
              </Text>
            )}
            {answer.citations.map((c) => (
              <Pressable key={`${c.n}:${c.slug}`} onPress={() => open(c.slug)} style={{ gap: 2 }}>
                <Text style={{ color: t.accent, fontSize: 12, fontWeight: "700" }}>
                  [{c.n}] {c.name}
                  {c.heading ? ` · ${c.heading}` : ""}
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
              const p = bySlug.get(h.slug);
              return p ? <Row key={h.slug} p={p} sub={h.snippet || h.heading || p.description} /> : null;
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
