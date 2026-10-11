import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { BookmarkPlus, ExternalLink, Loader2 } from "lucide-react";
import type { Skill } from "@labee/contracts";
import { Markdown } from "~/components/Markdown";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { apiGet, apiSend } from "~/lib/api";
import { useCurrentUser } from "~/lib/auth";

/** A protocol in the shared library, read-only here; saving makes a copy
 *  that is the person's own. */
interface LibraryProtocol {
  id: string;
  source: string;
  sourceUrl: string;
  doi?: string;
  license: string;
  title: string;
  description: string;
  category?: string;
  domains: string[];
  keywords: string[];
  problem?: string;
  method?: string;
  application?: string;
  body: string;
}

export const Route = createFileRoute("/library/$id")({
  component: LibraryProtocolPage,
});

function LibraryProtocolPage() {
  const { id } = Route.useParams();
  const { data: user } = useCurrentUser();
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["library", id],
    queryFn: () => apiGet<{ protocol: LibraryProtocol }>(`/api/library/${encodeURIComponent(id)}`),
  });
  const catsQ = useQuery({
    queryKey: ["protocol-categories"],
    queryFn: () => apiGet<{ categories: string[] }>("/api/skills/categories"),
    enabled: !!user,
  });
  const [category, setCategory] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      apiSend<{ skill: Skill; already: boolean }>("POST", "/api/library/import", {
        id,
        ...(category ? { category } : {}),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["skills"] });
      void qc.invalidateQueries({ queryKey: ["protocol-categories"] });
    },
  });

  if (isLoading) {
    return <p className="mx-auto w-full max-w-[var(--content-width)] px-6 py-16 text-sm text-ink-light">Loading…</p>;
  }
  if (error || !data) {
    return (
      <div className="mx-auto w-full max-w-[var(--content-width)] px-6 py-16">
        <p className="text-sm text-ink-light">
          {error instanceof Error && /reachable/.test(error.message)
            ? error.message
            : "This library protocol could not be found."}
        </p>
        <Button variant="link" size="sm" className="mt-4 px-0" render={<Link to="/protocols" />}>
          ← Protocols
        </Button>
      </div>
    );
  }

  const p = data.protocol;
  const chosenCategory = category ?? p.category ?? "";
  return (
    <article className="mx-auto w-full max-w-[var(--content-width)] px-6 py-10">
      <Button variant="link" size="xs" className="px-0 text-ink-light" render={<Link to="/protocols" />}>
        ← Protocols
      </Button>

      <header className="mt-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-3xl tracking-tight text-ink">{p.title}</h1>
          <p className="mt-2 flex flex-wrap items-center gap-2 font-mono text-xs uppercase tracking-wider text-ink-faint">
            <span>Library · {p.source}</span>
            <Badge variant="outline" className="text-[11px] normal-case tracking-normal">
              {p.license}
            </Badge>
            {p.sourceUrl && (
              <a href={p.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 normal-case tracking-normal text-brand hover:underline">
                Source <ExternalLink className="size-3" />
              </a>
            )}
          </p>
        </div>
      </header>

      {p.description && <p className="mt-4 text-base text-ink-light">{p.description}</p>}

      {(p.problem || p.method || p.application || p.domains.length > 0) && (
        <dl className="mt-5 grid gap-x-6 gap-y-2 rounded-xl border border-border bg-card p-4 text-sm sm:grid-cols-[auto_1fr]">
          {p.problem && (<><dt className="text-ink-faint">Problem</dt><dd className="text-ink">{p.problem}</dd></>)}
          {p.method && (<><dt className="text-ink-faint">Method</dt><dd className="text-ink">{p.method}</dd></>)}
          {p.application && (<><dt className="text-ink-faint">Use it for</dt><dd className="text-ink">{p.application}</dd></>)}
          {p.domains.length > 0 && (
            <>
              <dt className="text-ink-faint">Domains</dt>
              <dd className="flex flex-wrap gap-1.5">
                {p.domains.map((d) => (
                  <Badge key={d} variant="outline" className="text-[11px]">{d}</Badge>
                ))}
              </dd>
            </>
          )}
        </dl>
      )}

      {user && (
        <div className="mt-6 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4">
          {save.data ? (
            <p className="text-sm text-ink">
              {save.data.already ? "Already in your protocols: " : "Saved to your protocols: "}
              <Link to="/skills/$slug" params={{ slug: save.data.skill.slug }} className="font-medium text-brand hover:underline">
                {save.data.skill.name}
              </Link>
            </p>
          ) : (
            <>
              <label className="flex items-center gap-2 text-sm text-ink-light">
                Category
                <select
                  value={chosenCategory}
                  onChange={(e) => setCategory(e.target.value)}
                  className="h-8 rounded-md border border-border bg-card px-2 text-sm text-ink focus:border-ink focus:outline-none"
                >
                  {p.category && !(catsQ.data?.categories ?? []).includes(p.category) && (
                    <option value={p.category}>{p.category} (new)</option>
                  )}
                  {(catsQ.data?.categories ?? []).map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                  <option value="">No category</option>
                </select>
              </label>
              <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? <Loader2 className="size-4 animate-spin" /> : <BookmarkPlus className="size-4" />}
                Save to my protocols
              </Button>
              <span className="text-xs text-ink-faint">
                Your copy is yours to edit; it keeps the source and licence as a reference.
              </span>
              {save.isError && (
                <span className="text-sm text-destructive">
                  {save.error instanceof Error ? save.error.message : "Could not save."}
                </span>
              )}
            </>
          )}
        </div>
      )}

      <div className="mt-10 border-t border-border pt-8">
        <Markdown>{p.body}</Markdown>
      </div>
    </article>
  );
}
