"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, Pencil } from "lucide-react";
import type { Skill } from "@/lib/types";

interface Props {
  skill: Skill;
}

interface ImportResponse {
  imported: { slug: string; ok: true; skill: Skill }[];
  failed: { slug: string; ok: false; error: string }[];
}

/**
 * Edit entry point on a skill detail page.
 *
 *   - User-source: a plain link to /skills/<slug>/edit.
 *   - Public-source: a button that imports the skill into the caller's own
 *     folder in the background, then redirects to the new editable copy's
 *     edit page. The user gets a single-click "make this mine" experience
 *     without ever leaving the detail page until the import is done.
 *   - Plugin-source: not editable here; component renders nothing.
 */
export default function EditSkillButton({ skill }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (skill.source.kind === "user") {
    return (
      <Link
        href={`/skills/${skill.slug}/edit`}
        className="inline-flex items-center gap-2 border border-rule px-3 py-1.5 text-xs font-medium text-muted transition hover:border-ink hover:text-ink"
      >
        <Pencil size={13} />
        Edit
      </Link>
    );
  }

  if (skill.source.kind !== "public") {
    // plugin-source: no edit-here action
    return null;
  }

  async function importThenEdit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/skills/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slugs: [skill.slug] }),
      });
      const data = (await res.json()) as ImportResponse | { error?: string };
      if (!res.ok && "error" in data && res.status !== 207) {
        throw new Error(data.error ?? `Import failed (HTTP ${res.status})`);
      }
      const result = data as ImportResponse;
      const first = result.imported?.[0];
      if (!first) {
        const reason = result.failed?.[0]?.error ?? "Unknown error.";
        throw new Error(reason);
      }
      router.push(`/skills/${first.skill.slug}/edit`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed.");
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={importThenEdit}
        disabled={busy}
        title="Copies this public skill into your private folder so you can edit it."
        className="inline-flex items-center gap-2 border border-rule px-3 py-1.5 text-xs font-medium text-muted transition hover:border-ink hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Pencil size={13} />}
        {busy ? "Importing…" : "Edit"}
      </button>
      {error && (
        <span className="text-[11px] text-red-700">{error}</span>
      )}
    </span>
  );
}
