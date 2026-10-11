// The protocol library on a phone. It opens on a menu — your own protocols
// and the shared library on labee.online, each with its count and its
// shelves (categories) — and a shelf opens to its titles. Typing searches
// across whichever pool is chosen; a question is answered from the same, with
// the passages it used. Own protocols are read from whichever machine is
// selected under Settings › Devices.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  askProtocols,
  indexStatus,
  isLibrarySlug,
  libraryIdOf,
  libraryShelves,
  listLibrary,
  listProtocols,
  searchProtocols,
  whereLabel,
  type AskResult,
  type IndexStatus,
  type LibraryListing,
  type LibraryShelf,
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
const SHELF_PAGE = 100;

/** Where the browser is: the menu of both pools, or one shelf of one pool. */
type Browse = { kind: "menu" } | { kind: "shelf"; pool: "mine" | "library"; name: string };

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
  const [browse, setBrowse] = useState<Browse>({ kind: "menu" });
  // The library's shelves, as the box counts them; null until fetched, and
  // left null when the box cannot be reached, which the menu then says.
  const [shelves, setShelves] = useState<{ total: number; categories: LibraryShelf[] } | null>(null);
  const [shelvesErr, setShelvesErr] = useState<string | null>(null);
  // The open library shelf's titles, a page at a time.
  const [shelf, setShelf] = useState<{ name: string; total: number; items: LibraryListing[] } | null>(null);
  const [shelfLoading, setShelfLoading] = useState(false);
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
  const loadShelves = useCallback(async () => {
    try {
      setShelves(await libraryShelves(target));
      setShelvesErr(null);
    } catch (e) {
      setShelves(null);
      setShelvesErr(e instanceof Error ? e.message : String(e));
    }
  }, [target]);
  useFocusEffect(
    useCallback(() => {
      void load();
      void loadShelves();
    }, [load, loadShelves]),
  );

  // A library shelf is read from the box when opened, and again for each
  // further page. Own shelves need no fetch: they are a filter over `all`.
  const openShelf = async (pool: "mine" | "library", name: string) => {
    setBrowse({ kind: "shelf", pool, name });
    if (pool !== "library") return;
    setShelf({ name, total: 0, items: [] });
    setShelfLoading(true);
    try {
      const r = await listLibrary(target, name === UNCATEGORISED ? UNCATEGORISED : name, SHELF_PAGE, 0);
      setShelf({ name, total: r.total, items: r.protocols });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setShelfLoading(false);
    }
  };
  const moreShelf = async () => {
    if (!shelf || shelfLoading || shelf.items.length >= shelf.total) return;
    setShelfLoading(true);
    try {
      const r = await listLibrary(target, shelf.name, SHELF_PAGE, shelf.items.length);
      setShelf((s) => (s && s.name === shelf.name ? { ...s, total: r.total, items: [...s.items, ...r.protocols] } : s));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setShelfLoading(false);
    }
  };

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

  const LibraryRow = ({ p }: { p: LibraryListing }) => (
    <Pressable
      onPress={() => open(`library:${p.id}`)}
      style={{ paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: t.border, gap: 3 }}
    >
      <Text numberOfLines={1} style={{ color: t.text, fontSize: 15, fontWeight: "600" }}>{p.title}</Text>
      <Text style={{ color: t.muted, fontSize: 11 }}>
        Library · {p.source}{p.license ? ` · ${p.license}` : ""}
      </Text>
      {p.description ? <Text numberOfLines={2} style={{ color: t.muted, fontSize: 12 }}>{p.description}</Text> : null}
    </Pressable>
  );

  /** One line of the menu: a shelf's name and how many it holds. */
  const ShelfRow = ({ pool, name, count }: { pool: "mine" | "library"; name: string; count: number }) => (
    <Pressable
      onPress={() => void openShelf(pool, name)}
      accessibilityRole="button"
      style={{ flexDirection: "row", alignItems: "center", paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: t.border }}
    >
      <Text numberOfLines={1} style={{ color: t.text, fontSize: 15, flex: 1 }}>{name}</Text>
      <Text style={{ color: t.muted, fontSize: 13, marginLeft: 12 }}>{count}</Text>
      <Text style={{ color: t.muted, fontSize: 18, marginLeft: 8 }}>›</Text>
    </Pressable>
  );

  /** A pool's heading on the menu: its name and its total. */
  const PoolHeader = ({ title, total, sub }: { title: string; total: number | null; sub?: string }) => (
    <View style={{ paddingHorizontal: 16, paddingTop: 20, paddingBottom: 8, gap: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" }}>
        <Text style={{ color: t.text, fontSize: 17, fontWeight: "700" }}>{title}</Text>
        <Text style={{ color: t.accent, fontSize: 17, fontWeight: "700" }}>{total === null ? "—" : total.toLocaleString()}</Text>
      </View>
      {sub ? <Text style={{ color: t.muted, fontSize: 12 }}>{sub}</Text> : null}
    </View>
  );

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
        ) : browse.kind === "menu" ? (
          <>
            <PoolHeader title="My protocols" total={all.length} sub="On the selected machine" />
            {groups.map(([category, items]) => (
              <ShelfRow key={`mine:${category}`} pool="mine" name={category} count={items.length} />
            ))}
            {all.length === 0 && !err ? (
              <Text style={{ color: t.muted, paddingHorizontal: 16, paddingVertical: 12, fontSize: 13 }}>
                No protocols on this machine yet.
              </Text>
            ) : null}

            <PoolHeader title="Online library" total={shelves ? shelves.total : null} sub="Shared on labee.online" />
            {shelves ? (
              shelves.categories.map((c) => <ShelfRow key={`library:${c.name}`} pool="library" name={c.name} count={c.count} />)
            ) : (
              <Text style={{ color: t.muted, paddingHorizontal: 16, paddingVertical: 12, fontSize: 13 }}>
                {shelvesErr ? "The library on labee.online could not be reached." : "Loading…"}
              </Text>
            )}
          </>
        ) : (
          <>
            <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingTop: 12, paddingBottom: 4, gap: 8 }}>
              <Button kind="ghost" title="‹ All" onPress={() => { setBrowse({ kind: "menu" }); setShelf(null); }} />
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={{ color: t.text, fontSize: 17, fontWeight: "700" }}>{browse.name}</Text>
                <Text style={{ color: t.muted, fontSize: 12 }}>
                  {browse.pool === "mine"
                    ? `My protocols · ${groups.find(([c]) => c === browse.name)?.[1].length ?? 0}`
                    : `Online library · ${shelf && shelf.name === browse.name ? shelf.total.toLocaleString() : "…"}`}
                </Text>
              </View>
            </View>
            {browse.pool === "mine"
              ? (groups.find(([c]) => c === browse.name)?.[1] ?? []).map((p) => <Row key={p.slug} p={p} />)
              : (shelf?.items ?? []).map((p) => <LibraryRow key={p.id} p={p} />)}
            {browse.pool === "library" && shelf && shelf.items.length < shelf.total ? (
              <View style={{ padding: 16, alignItems: "center" }}>
                <Button kind="ghost" title={shelfLoading ? "Loading…" : `Show more (${shelf.items.length.toLocaleString()} of ${shelf.total.toLocaleString()})`} onPress={moreShelf} disabled={shelfLoading} />
              </View>
            ) : shelfLoading ? (
              <ActivityIndicator color={t.muted} style={{ padding: 16 }} />
            ) : null}
          </>
        )}
        <View style={{ height: 32 }} />
      </ScrollView>
    </Screen>
  );
}
