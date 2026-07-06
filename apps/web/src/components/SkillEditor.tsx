
import { Link, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { ArrowLeft, Plus, Save, Trash2, Upload, Loader2 } from "lucide-react";
import type { ArtifactKind, Skill } from "@labee/contracts";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";

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
  // Spreads through props so it can back a Button via its `render` prop.
  const CancelLink = ({
    children,
    ...rest
  }: {
    children: React.ReactNode;
  } & Record<string, unknown>) =>
    skill ? (
      <Link to="/skills/$slug" params={{ slug: skill.slug }} {...rest}>
        {children}
      </Link>
    ) : (
      <Link to="/skills" {...rest}>
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
    <form onSubmit={onSave} className="mx-auto w-full max-w-[860px] px-6 py-10 sm:px-8">
      <div className="flex items-center justify-between gap-3">
        <Button
          variant="ghost"
          size="sm"
          className="px-2 text-ink-light"
          render={
            <CancelLink>
              <ArrowLeft />
              Back
            </CancelLink>
          }
        />
        {!isCreate && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onDelete}
            disabled={busy}
            className="text-ink-light"
          >
            <Trash2 />
            Delete
          </Button>
        )}
      </div>

      <header className="mt-8 border-b border-border pb-6">
        <p className="mb-2 text-xs font-medium uppercase tracking-wider text-ink-faint">
          {isCreate
            ? `Create ${kind === "protocol" ? "protocol" : "skill"}`
            : `Edit ${skill!.artifactKind === "protocol" ? "protocol" : "skill"}`}
        </p>
        <h1 className="font-display text-3xl leading-tight tracking-tight text-ink">
          {isCreate
            ? name.trim() ||
              (kind === "protocol" ? "New protocol" : "New skill")
            : skill!.name}
        </h1>
        {!isCreate && (
          <p className="mt-2 font-mono text-xs text-ink-light">
            {skill!.sourcePath}/SKILL.md
          </p>
        )}
        {isCreate && (
          <p className="mt-2 text-xs text-ink-light">
            A new directory will be created in your user skills root, derived
            from the name.
          </p>
        )}
      </header>

      <div className="mt-8 space-y-6 rounded-lg border border-border bg-card p-6 shadow-xs">
        <Field
          htmlFor="skill-name"
          label="Name"
          hint="Used as the skill identifier in YAML frontmatter."
        >
          <Input
            id="skill-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder={isCreate ? "my-skill" : undefined}
            className="font-mono"
          />
        </Field>

        <Field
          htmlFor="skill-description"
          label="Description"
          hint="One-line summary of when to use this artifact."
        >
          <Textarea
            id="skill-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="leading-relaxed"
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
                <Button
                  key={k}
                  type="button"
                  variant={on ? "default" : "outline"}
                  size="sm"
                  onClick={() => setKind(k)}
                >
                  {k === "skill" ? "Skill" : "Protocol"}
                </Button>
              );
            })}
          </div>
        </Field>

        <Field
          htmlFor="skill-allowed-tools"
          label="Allowed tools"
          hint="Comma- or newline-separated. Leave empty to inherit defaults."
        >
          <Input
            id="skill-allowed-tools"
            type="text"
            value={allowedTools}
            onChange={(e) => setAllowedTools(e.target.value)}
            placeholder="Read, Write, Bash"
            className="font-mono"
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
              <Button
                variant="outline"
                size="sm"
                disabled={importing}
                render={<label htmlFor="protocol-import-file" />}
                className={cn(importing && "cursor-default")}
              >
                {importing ? (
                  <>
                    <Loader2 className="animate-spin" /> Importing…
                  </>
                ) : (
                  <>
                    <Upload /> Choose file
                  </>
                )}
              </Button>
              {importedFrom && !importing && (
                <span className="font-mono text-xs text-ink-light">
                  Imported from <span className="text-ink">{importedFrom}</span>
                  . Review the body below.
                </span>
              )}
            </div>
            {importError && (
              <p className="mt-2 text-xs text-destructive">{importError}</p>
            )}
          </Field>
        )}

        <Field
          htmlFor="skill-body"
          label="Body (markdown)"
          hint="Everything below the YAML frontmatter."
        >
          <Textarea
            id="skill-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={24}
            spellCheck={false}
            className="min-h-[28rem] font-mono text-[13px] leading-relaxed"
          />
        </Field>
      </div>

      {error && (
        <div className="mt-6 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="mt-8 flex items-center gap-3 border-t border-border pt-6">
        <Button type="submit" variant="default" disabled={busy}>
          {isCreate ? <Plus /> : <Save />}
          {saving
            ? isCreate
              ? "Creating…"
              : "Saving…"
            : isCreate
              ? "Create skill"
              : "Save changes"}
        </Button>
        <Button
          variant="ghost"
          render={<CancelLink>Cancel</CancelLink>}
          className="text-ink-light"
        />
      </div>
    </form>
  );
}

function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="block">
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <label htmlFor={htmlFor} className="text-sm font-medium text-ink">
          {label}
        </label>
        {hint && <span className="text-xs text-ink-light">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
