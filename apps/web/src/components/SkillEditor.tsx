
import { Link, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { ArrowLeft, Plus, Save, Trash2, Upload, Loader2 } from "lucide-react";
import type { ArtifactKind, Skill } from "@labee/contracts";

interface Props {
  /** Existing skill to edit. Omit (along with mode='create') to create a new one. */
  skill?: Skill;
  mode?: "edit" | "create";
}

export default function SkillEditor({ skill, mode = "edit" }: Props) {
  const isCreate = mode === "create" || !skill;
  const navigate = useNavigate();
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [allowedTools, setAllowedTools] = useState(
    skill?.allowedTools.join(", ") ?? "",
  );
  const [kind, setKind] = useState<ArtifactKind>(skill?.artifactKind ?? "skill");
  const [body, setBody] = useState(
    skill?.body ?? "# New artifact\n\nDescribe how the agent should use this artifact.\n",
  );
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importedFrom, setImportedFrom] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Typed-router back/cancel link to the source artifact (or the catalog).
  const CancelLink = ({
    className,
    children,
  }: {
    className?: string;
    children: React.ReactNode;
  }) =>
    skill ? (
      <Link to="/skills/$slug" params={{ slug: skill.slug }} className={className}>
        {children}
      </Link>
    ) : (
      <Link to="/skills" className={className}>
        {children}
      </Link>
    );

  function nameFromFilename(filename: string): string {
    const base = filename.replace(/\.[^./\\]+$/, "");
    return base
      .replace(/[_\-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  async function onImportFile(file: File) {
    setImportError(null);
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/artifacts/extract-text", {
        method: "POST",
        body: fd,
      });
      const data = (await res.json().catch(() => ({}))) as {
        text?: string;
        filename?: string;
        error?: string;
      };
      if (!res.ok || typeof data.text !== "string") {
        throw new Error(data.error ?? `Import failed (HTTP ${res.status})`);
      }
      setBody(data.text || "");
      setImportedFrom(file.name);
      if (!name.trim()) {
        const suggested = nameFromFilename(file.name);
        if (suggested) setName(suggested);
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const payload = {
        name,
        description,
        allowedTools: allowedTools
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter(Boolean),
        license: skill?.license,
        body,
        kind,
      };
      const res = isCreate
        ? await fetch(`/api/skills`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch(`/api/skills/${skill!.slug}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      const data = (await res.json()) as { skill?: Skill; error?: string };
      if (!res.ok || !data.skill) {
        throw new Error(data.error ?? `Save failed (HTTP ${res.status})`);
      }
      void navigate({ to: "/skills/$slug", params: { slug: data.skill.slug } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (!skill) return;
    if (!confirm(`Delete skill "${skill.name}"? This removes ${skill.sourcePath}.`)) return;
    setError(null);
    setDeleting(true);
    try {
      const res = await fetch(`/api/skills/${skill.slug}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Delete failed (HTTP ${res.status})`);
      }
      void navigate({ to: "/skills" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed.");
      setDeleting(false);
    }
  }

  const busy = saving || deleting;

  return (
    <form onSubmit={onSave} className="mx-auto max-w-3xl px-6 pb-24 pt-12">
      <div className="flex items-center justify-between gap-3">
        <CancelLink className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-muted transition hover:text-ink">
          <ArrowLeft size={14} />
          Back
        </CancelLink>
        {!isCreate && (
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className="inline-flex items-center gap-2 border border-rule px-3 py-1.5 text-xs font-medium text-muted transition hover:border-ink hover:text-ink disabled:opacity-50"
          >
            <Trash2 size={13} />
            Delete
          </button>
        )}
      </div>

      <header className="mt-8 border-b border-rule pb-6">
        <p className="mb-2 text-xs uppercase tracking-[0.22em] text-muted">
          {isCreate
            ? `Create ${kind === "protocol" ? "protocol" : "skill"}`
            : `Edit ${skill!.artifactKind === "protocol" ? "protocol" : "skill"}`}
        </p>
        <h1 className="font-serif text-3xl leading-tight tracking-tight text-ink">
          {isCreate
            ? name.trim() ||
              (kind === "protocol" ? "New protocol" : "New skill")
            : skill!.name}
        </h1>
        {!isCreate && (
          <p className="mt-2 font-mono text-xs text-muted">
            {skill!.sourcePath}/SKILL.md
          </p>
        )}
        {isCreate && (
          <p className="mt-2 text-xs text-muted">
            A new directory will be created in your user skills root, derived
            from the name.
          </p>
        )}
      </header>

      <div className="mt-8 space-y-6">
        <Field label="Name" hint="Used as the skill identifier in YAML frontmatter.">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder={isCreate ? "my-skill" : undefined}
            className="w-full border border-rule bg-paper px-3 py-2 font-mono text-sm text-ink focus:border-ink focus:outline-none"
          />
        </Field>

        <Field label="Description" hint="One-line summary of when to use this artifact.">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full resize-y border border-rule bg-paper px-3 py-2 text-sm leading-relaxed text-ink focus:border-ink focus:outline-none"
          />
        </Field>

        <Field
          label="Kind"
          hint="Skill = a generic Claude Code capability. Protocol = a laboratory procedure you author."
        >
          <div className="flex items-center gap-2">
            {(["skill", "protocol"] as ArtifactKind[]).map((k) => {
              const on = kind === k;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={`border px-3 py-1.5 text-xs transition ${
                    on
                      ? "border-ink bg-ink text-paper"
                      : "border-rule text-muted hover:border-ink hover:text-ink"
                  }`}
                >
                  {k === "skill" ? "Skill" : "Protocol"}
                </button>
              );
            })}
          </div>
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

        {isCreate && kind === "protocol" && (
          <Field
            label="Import from file"
            hint=".md, .txt, .pdf, .docx work everywhere. .doc, .odt, .rtf need LibreOffice on the server. Text is extracted and dropped into the body below for review."
          >
            <div className="flex flex-wrap items-center gap-3">
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,.markdown,.txt,.text,.pdf,.docx,.doc,.odt,.rtf"
                disabled={importing}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onImportFile(f);
                }}
                className="hidden"
                id="protocol-import-file"
              />
              <label
                htmlFor="protocol-import-file"
                className={`inline-flex cursor-pointer items-center gap-2 border border-rule px-3 py-1.5 text-xs transition ${
                  importing
                    ? "opacity-50"
                    : "hover:border-ink hover:text-ink"
                }`}
              >
                {importing ? (
                  <>
                    <Loader2 size={13} className="animate-spin" /> Importing…
                  </>
                ) : (
                  <>
                    <Upload size={13} /> Choose file
                  </>
                )}
              </label>
              {importedFrom && !importing && (
                <span className="font-mono text-xs text-muted">
                  Imported from <span className="text-ink">{importedFrom}</span>
                  . Review the body below.
                </span>
              )}
            </div>
            {importError && (
              <p className="mt-2 text-xs text-red-600">{importError}</p>
            )}
          </Field>
        )}

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
          {isCreate ? <Plus size={14} /> : <Save size={14} />}
          {saving
            ? isCreate
              ? "Creating…"
              : "Saving…"
            : isCreate
              ? "Create skill"
              : "Save changes"}
        </button>
        <CancelLink className="px-4 py-2 text-sm text-muted transition hover:text-ink">
          Cancel
        </CancelLink>
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
