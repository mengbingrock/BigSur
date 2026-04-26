"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowLeft, Save, Trash2 } from "lucide-react";
import type { Skill } from "@/lib/types";

interface Props {
  skill: Skill;
}

export default function SkillEditor({ skill }: Props) {
  const router = useRouter();
  const [name, setName] = useState(skill.name);
  const [description, setDescription] = useState(skill.description);
  const [allowedTools, setAllowedTools] = useState(skill.allowedTools.join(", "));
  const [body, setBody] = useState(skill.body);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/skills/${skill.slug}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description,
          allowedTools: allowedTools
            .split(/[\n,]/)
            .map((s) => s.trim())
            .filter(Boolean),
          license: skill.license,
          body,
        }),
      });
      const data = (await res.json()) as { skill?: Skill; error?: string };
      if (!res.ok || !data.skill) {
        throw new Error(data.error ?? `Save failed (HTTP ${res.status})`);
      }
      // Slug may have shifted if the user renamed.
      router.push(`/skills/${data.skill.slug}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (!confirm(`Delete skill "${skill.name}"? This removes ${skill.sourcePath}.`)) return;
    setError(null);
    setDeleting(true);
    try {
      const res = await fetch(`/api/skills/${skill.slug}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Delete failed (HTTP ${res.status})`);
      }
      router.push("/skills");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed.");
      setDeleting(false);
    }
  }

  const busy = saving || deleting;

  return (
    <form onSubmit={onSave} className="mx-auto max-w-3xl px-6 pb-24 pt-12">
      <div className="flex items-center justify-between gap-3">
        <Link
          href={`/skills/${skill.slug}`}
          className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-muted transition hover:text-ink"
        >
          <ArrowLeft size={14} />
          Back
        </Link>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="inline-flex items-center gap-2 border border-rule px-3 py-1.5 text-xs font-medium text-muted transition hover:border-ink hover:text-ink disabled:opacity-50"
        >
          <Trash2 size={13} />
          Delete
        </button>
      </div>

      <header className="mt-8 border-b border-rule pb-6">
        <p className="mb-2 text-xs uppercase tracking-[0.22em] text-muted">Edit skill</p>
        <h1 className="font-serif text-3xl leading-tight tracking-tight text-ink">
          {skill.name}
        </h1>
        <p className="mt-2 font-mono text-xs text-muted">{skill.sourcePath}/SKILL.md</p>
      </header>

      <div className="mt-8 space-y-6">
        <Field label="Name" hint="Used as the skill identifier in YAML frontmatter.">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full border border-rule bg-paper px-3 py-2 font-mono text-sm text-ink focus:border-ink focus:outline-none"
          />
        </Field>

        <Field label="Description" hint="One-line summary of when to use this skill.">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full resize-y border border-rule bg-paper px-3 py-2 text-sm leading-relaxed text-ink focus:border-ink focus:outline-none"
          />
        </Field>

        <Field
          label="Allowed tools"
          hint="Comma- or newline-separated. Leave empty to inherit defaults."
        >
          <input
            type="text"
            value={allowedTools}
            onChange={(e) => setAllowedTools(e.target.value)}
            placeholder="Read, Write, Bash"
            className="w-full border border-rule bg-paper px-3 py-2 font-mono text-sm text-ink focus:border-ink focus:outline-none"
          />
        </Field>

        <Field label="Body (markdown)" hint="Everything below the YAML frontmatter.">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={24}
            spellCheck={false}
            className="w-full resize-y border border-rule bg-paper px-3 py-2 font-mono text-[13px] leading-relaxed text-ink focus:border-ink focus:outline-none"
          />
        </Field>
      </div>

      {error && (
        <div className="mt-6 border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="mt-8 flex items-center gap-3 border-t border-rule pt-6">
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-2 border border-ink bg-ink px-4 py-2 text-sm font-medium text-paper transition hover:bg-paper hover:text-ink disabled:opacity-50"
        >
          <Save size={14} />
          {saving ? "Saving…" : "Save changes"}
        </button>
        <Link
          href={`/skills/${skill.slug}`}
          className="px-4 py-2 text-sm text-muted transition hover:text-ink"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium uppercase tracking-[0.18em] text-ink">
          {label}
        </span>
        {hint && <span className="text-[11px] text-muted">{hint}</span>}
      </div>
      {children}
    </label>
  );
}
