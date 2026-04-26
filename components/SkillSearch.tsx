"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Fuse from "fuse.js";
import { Download, Search, X } from "lucide-react";
import type { Skill } from "@/lib/types";
import SkillCard from "./SkillCard";
import SourceFilter from "./SourceFilter";

interface Props {
  skills: Skill[];
  sources: string[];
}

interface ImportResponse {
  imported: { slug: string; ok: true; skill: Skill }[];
  failed: { slug: string; ok: false; error: string }[];
}

export default function SkillSearch({ skills, sources }: Props) {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const fuse = useMemo(
    () =>
      new Fuse(skills, {
        keys: [
          { name: "name", weight: 0.5 },
          { name: "description", weight: 0.4 },
          { name: "allowedTools", weight: 0.1 },
        ],
        threshold: 0.35,
        ignoreLocation: true,
      }),
    [skills],
  );

  const filtered = useMemo(() => {
    const base = query.trim() ? fuse.search(query.trim()).map((r) => r.item) : skills;
    return source ? base.filter((s) => s.sourceLabel === source) : base;
  }, [fuse, query, skills, source]);

  const publicSkills = useMemo(
    () => skills.filter((s) => s.source.kind === "public"),
    [skills],
  );

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search skills…"
            className="w-full border border-rule bg-paper py-2 pl-9 pr-3 text-sm text-ink placeholder:text-muted focus:border-ink focus:outline-none"
          />
        </div>
        <div className="flex items-center gap-3">
          {publicSkills.length > 0 && (
            <button
              type="button"
              onClick={() => setImportOpen(true)}
              className="inline-flex shrink-0 items-center gap-2 border border-rule bg-paper px-3 py-2 text-sm font-medium text-ink transition hover:border-ink"
            >
              <Download size={14} />
              Import from public
            </button>
          )}
          <SourceFilter sources={sources} selected={source} onChange={setSource} />
        </div>
      </div>

      <p className="mb-4 text-xs uppercase tracking-[0.18em] text-muted">
        {filtered.length} skill{filtered.length === 1 ? "" : "s"}
      </p>

      {filtered.length === 0 ? (
        <div className="border border-dashed border-rule p-10 text-center text-sm text-muted">
          No skills match these filters.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((s) => (
            <SkillCard key={s.slug} skill={s} />
          ))}
        </div>
      )}

      {importOpen && (
        <ImportFromPublicModal
          publicSkills={publicSkills}
          onClose={() => setImportOpen(false)}
        />
      )}
    </div>
  );
}

function ImportFromPublicModal({
  publicSkills,
  onClose,
}: {
  publicSkills: Skill[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  // Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  function toggle(slug: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(publicSkills.map((s) => s.slug)));
  }

  function clearAll() {
    setSelected(new Set());
  }

  async function onImport() {
    if (selected.size === 0) return;
    setBusy(true);
    setError(null);
    setWarnings([]);
    try {
      const res = await fetch("/api/skills/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slugs: Array.from(selected) }),
      });
      const data = (await res.json()) as ImportResponse | { error?: string };
      if (!res.ok && "error" in data && res.status !== 207) {
        throw new Error(data.error ?? `Import failed (HTTP ${res.status})`);
      }
      const result = data as ImportResponse;
      if (result.failed && result.failed.length > 0) {
        setWarnings(result.failed.map((f) => `${f.slug}: ${f.error}`));
      }
      if (result.imported && result.imported.length > 0) {
        // Close on full or partial success — refresh shows the new skills.
        router.refresh();
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  }

  const count = selected.size;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col border border-rule bg-paper shadow-lg">
        <header className="flex items-center justify-between border-b border-rule px-5 py-4">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-muted">
              Import
            </p>
            <h2 className="font-serif text-2xl tracking-tight text-ink">
              Copy public skills to your folder
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="text-muted transition hover:text-ink disabled:opacity-50"
          >
            <X size={18} />
          </button>
        </header>

        <div className="flex items-center justify-between border-b border-rule px-5 py-2 text-xs text-muted">
          <span>
            {publicSkills.length} public skill{publicSkills.length === 1 ? "" : "s"} available
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={selectAll}
              disabled={busy || count === publicSkills.length}
              className="underline underline-offset-2 transition hover:text-ink disabled:no-underline disabled:opacity-50"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={clearAll}
              disabled={busy || count === 0}
              className="underline underline-offset-2 transition hover:text-ink disabled:no-underline disabled:opacity-50"
            >
              Clear
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {publicSkills.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-muted">
              No public skills are available right now.
            </p>
          ) : (
            <ul>
              {publicSkills.map((s) => {
                const checked = selected.has(s.slug);
                return (
                  <li
                    key={s.slug}
                    className={`flex cursor-pointer items-start gap-3 border-b border-rule px-5 py-3 transition hover:bg-ink/5 ${
                      checked ? "bg-ink/5" : ""
                    }`}
                    onClick={() => !busy && toggle(s.slug)}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(s.slug)}
                      onClick={(e) => e.stopPropagation()}
                      disabled={busy}
                      className="mt-1 h-4 w-4 cursor-pointer accent-ink"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="truncate font-mono text-sm text-ink">
                          {s.name}
                        </span>
                        <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted">
                          {s.sourceLabel}
                        </span>
                      </div>
                      {s.description && (
                        <p className="mt-1 line-clamp-2 text-xs text-muted">
                          {s.description}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {(error || warnings.length > 0) && (
          <div className="border-t border-rule px-5 py-3">
            {error && (
              <p className="text-sm text-red-700">{error}</p>
            )}
            {warnings.length > 0 && (
              <ul className="mt-1 space-y-1 text-xs text-muted">
                {warnings.map((w, i) => (
                  <li key={i}>⚠ {w}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <footer className="flex items-center justify-between border-t border-rule px-5 py-4">
          <p className="text-xs text-muted">
            Imported skills land in your private folder; you can edit them.
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="px-3 py-2 text-sm text-muted transition hover:text-ink disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onImport}
              disabled={busy || count === 0}
              className="inline-flex items-center gap-2 border border-ink bg-ink px-4 py-2 text-sm font-medium text-paper transition hover:bg-paper hover:text-ink disabled:cursor-not-allowed disabled:border-rule disabled:bg-paper disabled:text-muted"
            >
              <Download size={14} />
              {busy
                ? "Importing…"
                : count === 0
                  ? "Import"
                  : `Import ${count} skill${count === 1 ? "" : "s"}`}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
