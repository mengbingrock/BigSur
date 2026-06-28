import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { Agent, AgentEngine, AgentUpdate, Skill } from "@labee/contracts";
import { Folder, FolderOpen, Loader2, Plus, X } from "lucide-react";

import { apiGet, apiSend } from "~/lib/api";
import { FolderPicker } from "~/components/FolderPicker";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";

interface AgentEditorProps {
  initial?: Agent;
  onSaved?: (a: Agent) => void;
}

export function AgentEditor({ initial, onSaved }: AgentEditorProps) {
  const qc = useQueryClient();
  const isEdit = !!initial;

  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [skillSlugs, setSkillSlugs] = useState<string[]>(initial?.skillSlugs ? [...initial.skillSlugs] : []);
  const [workingDir, setWorkingDir] = useState(initial?.workingDir ?? "");
  const [referenceFolders, setReferenceFolders] = useState<string[]>(
    initial?.referenceFolders ? [...initial.referenceFolders] : [],
  );
  const [engine, setEngine] = useState<AgentEngine>(initial?.engine ?? "claude");

  const enginesQ = useQuery({
    queryKey: ["agent-engines"],
    queryFn: () => apiGet<{ claude: boolean; codex: boolean }>("/api/agents/engines"),
    staleTime: 60_000,
  });
  const engines = enginesQ.data;

  const [showWorkingPicker, setShowWorkingPicker] = useState(!initial?.workingDir);
  const [showRefPicker, setShowRefPicker] = useState(false);
  const [skillQuery, setSkillQuery] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const skillsQ = useQuery({
    queryKey: ["skills"],
    queryFn: () => apiGet<{ skills: Skill[]; sources: string[] }>("/api/skills"),
  });

  const skills = useMemo(
    () => (skillsQ.data?.skills ?? []).filter((s) => s.artifactKind === "skill"),
    [skillsQ.data],
  );
  const filteredSkills = useMemo(() => {
    const q = skillQuery.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.slug.toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q),
    );
  }, [skills, skillQuery]);

  const toggleSkill = (slug: string) =>
    setSkillSlugs((prev) => (prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]));

  const mutation = useMutation({
    mutationFn: (payload: AgentUpdate) => {
      const url = isEdit ? "/api/agents/" + initial.id : "/api/agents";
      return apiSend<{ agent: Agent }>(isEdit ? "PUT" : "POST", url, payload);
    },
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["agents"] });
      if (isEdit) void qc.invalidateQueries({ queryKey: ["agent", initial.id] });
      onSaved?.(res.agent);
    },
    onError: (err) => setFormError(err instanceof Error ? err.message : "Failed to save agent."),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!name.trim()) {
      setFormError("Name is required.");
      return;
    }
    if (!workingDir.trim()) {
      setFormError("A working directory is required.");
      return;
    }
    const payload: AgentUpdate = {
      name: name.trim(),
      description: description.trim() || undefined,
      skillSlugs,
      workingDir: workingDir.trim(),
      referenceFolders,
      engine,
    };
    mutation.mutate(payload);
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-8">
      {/* Name + description */}
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="agent-name" className="font-medium text-ink text-sm">
            Name <span className="text-destructive">*</span>
          </label>
          <Input
            nativeInput
            id="agent-name"
            value={name}
            placeholder="e.g. Protocol drafting agent"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="agent-desc" className="font-medium text-ink text-sm">
            Description
          </label>
          <Textarea
            id="agent-desc"
            value={description}
            placeholder="What this agent is for (optional)."
            onChange={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
          />
        </div>
      </section>

      {/* Engine */}
      <section className="flex flex-col gap-2">
        <h2 className="font-display text-ink text-lg">Engine</h2>
        <p className="text-ink-light text-sm">
          Which locally-installed CLI runs this agent.
        </p>
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              { id: "claude", label: "Claude Code", hint: "Anthropic Claude Code CLI", available: engines?.claude },
              { id: "codex", label: "Codex", hint: "OpenAI Codex CLI", available: engines?.codex },
            ] as const
          ).map((opt) => {
            const selected = engine === opt.id;
            const unavailable = engines != null && !opt.available;
            return (
              <button
                key={opt.id}
                type="button"
                disabled={unavailable}
                onClick={() => setEngine(opt.id)}
                className={cn(
                  "flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2.5 text-left transition",
                  selected ? "border-brand bg-brand/5" : "border-border bg-card hover:bg-surface",
                  unavailable && "cursor-not-allowed opacity-50",
                )}
              >
                <span className="font-medium text-ink text-sm">{opt.label}</span>
                <span className="text-ink-faint text-xs">
                  {unavailable ? "Not installed" : opt.hint}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Skills */}
      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display text-ink text-lg">Skills</h2>
          <span className="text-ink-faint text-xs">{skillSlugs.length} selected</span>
        </div>
        <p className="text-ink-light text-sm">Choose the skills this agent can use.</p>
        {skills.length > 6 ? (
          <Input
            nativeInput
            size="sm"
            type="search"
            value={skillQuery}
            placeholder="Search skills…"
            onChange={(e) => setSkillQuery(e.target.value)}
          />
        ) : null}
        <div className="max-h-72 overflow-y-auto rounded-lg border border-border bg-card">
          {skillsQ.isLoading ? (
            <div className="flex items-center gap-2 px-3 py-4 text-ink-light text-sm">
              <Loader2 className="size-4 animate-spin" /> Loading skills…
            </div>
          ) : filteredSkills.length === 0 ? (
            <div className="px-3 py-4 text-ink-faint text-sm">No matching skills.</div>
          ) : (
            <ul className="divide-y divide-border">
              {filteredSkills.map((skill) => {
                const checked = skillSlugs.includes(skill.slug);
                return (
                  <li key={skill.slug}>
                    <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5 transition hover:bg-surface">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggleSkill(skill.slug)}
                        className="mt-0.5"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-ink text-sm">{skill.name}</span>
                        {skill.description ? (
                          <span className="line-clamp-2 block text-ink-light text-xs">
                            {skill.description}
                          </span>
                        ) : null}
                        <span className="block font-mono text-ink-faint text-[11px]">{skill.slug}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {/* Working directory */}
      <section className="flex flex-col gap-2">
        <h2 className="font-display text-ink text-lg">
          Working directory <span className="text-destructive">*</span>
        </h2>
        <p className="text-ink-light text-sm">Where the agent runs and writes its outputs.</p>
        {workingDir && !showWorkingPicker ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
            <FolderOpen className="size-4 shrink-0 text-ink-light" />
            <span className="min-w-0 flex-1 truncate font-mono text-ink text-sm" title={workingDir}>
              {workingDir}
            </span>
            <Button size="sm" variant="outline" onClick={() => setShowWorkingPicker(true)}>
              Change
            </Button>
          </div>
        ) : (
          <FolderPicker
            value={workingDir || undefined}
            title="Pick the working directory"
            onSelect={(p) => {
              setWorkingDir(p);
              setShowWorkingPicker(false);
            }}
          />
        )}
      </section>

      {/* Reference protocol folders */}
      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display text-ink text-lg">Reference protocol folders</h2>
          <span className="text-ink-faint text-xs">{referenceFolders.length} added</span>
        </div>
        <p className="text-ink-light text-sm">Read-only folders of reference protocols and docs.</p>

        {referenceFolders.length > 0 ? (
          <ul className="flex flex-col gap-1.5">
            {referenceFolders.map((folder) => (
              <li
                key={folder}
                className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
              >
                <Folder className="size-4 shrink-0 text-ink-light" />
                <span className="min-w-0 flex-1 truncate font-mono text-ink text-sm" title={folder}>
                  {folder}
                </span>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Remove folder"
                  onClick={() => setReferenceFolders((prev) => prev.filter((f) => f !== folder))}
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}

        {showRefPicker ? (
          <FolderPicker
            title="Add reference folders"
            multi
            selected={referenceFolders}
            onSelect={(p) =>
              setReferenceFolders((prev) => (prev.includes(p) ? prev : [...prev, p]))
            }
            onDone={() => setShowRefPicker(false)}
          />
        ) : (
          <div>
            <Button size="sm" variant="outline" onClick={() => setShowRefPicker(true)}>
              <Plus className="size-4" />
              Add folders
            </Button>
          </div>
        )}
      </section>

      {formError ? <p className="text-destructive text-sm">{formError}</p> : null}

      <div className={cn("flex items-center gap-3")}>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          {isEdit ? "Save changes" : "Create agent"}
        </Button>
        <Button variant="ghost" render={<Link to="/agents" />}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
