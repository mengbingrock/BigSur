"use client";

import { useState } from "react";
import { ChevronRight, FileIcon, FolderIcon, Pencil } from "lucide-react";
import type { SkillFile } from "@/lib/skills";
import Markdown from "./Markdown";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function isMarkdown(rel: string): boolean {
  const lower = rel.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

type TreeNode =
  | { kind: "file"; name: string; file: SkillFile }
  | { kind: "dir"; name: string; children: TreeNode[] };

function buildTree(files: SkillFile[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const file of files) {
    const segments = file.relPath.split("/");
    let level = root;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const isLeaf = i === segments.length - 1;
      if (isLeaf) {
        level.push({ kind: "file", name: seg, file });
      } else {
        let dir = level.find(
          (n): n is Extract<TreeNode, { kind: "dir" }> =>
            n.kind === "dir" && n.name === seg,
        );
        if (!dir) {
          dir = { kind: "dir", name: seg, children: [] };
          level.push(dir);
        }
        level = dir.children;
      }
    }
  }
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) if (n.kind === "dir") sortNodes(n.children);
  };
  sortNodes(root);
  return root;
}

interface FileNodeProps {
  name: string;
  file: SkillFile;
  slug: string;
  canEdit: boolean;
}

function FileNode({ name, file, slug, canEdit }: FileNodeProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(file.text ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedText, setSavedText] = useState(file.text ?? "");

  const meta = (
    <span className="font-mono text-[11px] text-muted">
      {formatBytes(file.size)}
      {file.truncated && " · truncated"}
      {file.binary && !file.truncated && " · binary"}
    </span>
  );

  const head = (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <FileIcon size={14} className="shrink-0 text-muted" aria-hidden />
      <span className="truncate font-mono text-sm text-ink">{name}</span>
    </span>
  );

  const editable = canEdit && !file.binary && !file.truncated && file.text !== undefined;

  if (file.binary || file.truncated || file.text === undefined) {
    return (
      <li className="flex items-baseline justify-between gap-3 border-l border-rule py-1.5 pl-3">
        {head}
        {meta}
      </li>
    );
  }

  async function onSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(slug)}/files`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ relPath: file.relPath, content: draft }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `Save failed (${res.status}).`);
      }
      setSavedText(draft);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="border-l border-rule">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-baseline justify-between gap-3 py-1.5 pl-3 transition hover:bg-rule/40">
          {head}
          <span className="flex items-center gap-3">{meta}</span>
        </summary>
        <div className="ml-4 mt-2 border-l border-rule pl-4 pb-4">
          {editing ? (
            <div className="space-y-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                className="block h-72 w-full resize-y border border-rule bg-paper px-3 py-2 font-mono text-xs leading-relaxed text-ink focus:border-ink focus:outline-none"
              />
              {error && (
                <p className="font-mono text-xs text-red-600">{error}</p>
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onSave}
                  disabled={saving || draft === savedText}
                  className="border border-ink bg-ink px-3 py-1 text-xs font-medium text-paper transition hover:bg-accent disabled:opacity-40"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(savedText);
                    setEditing(false);
                    setError(null);
                  }}
                  disabled={saving}
                  className="border border-rule px-3 py-1 text-xs text-muted transition hover:text-ink disabled:opacity-40"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {canEdit && (
                <div>
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(savedText);
                      setEditing(true);
                    }}
                    className="inline-flex items-center gap-1.5 border border-rule px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.12em] text-muted transition hover:border-ink hover:text-ink"
                  >
                    <Pencil size={11} aria-hidden />
                    Edit
                  </button>
                </div>
              )}
              {isMarkdown(file.relPath) ? (
                <Markdown>{savedText}</Markdown>
              ) : (
                <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-ink">
                  {savedText}
                </pre>
              )}
            </div>
          )}
        </div>
      </details>
    </li>
  );
}

interface DirNodeProps {
  name: string;
  nodes: TreeNode[];
  slug: string;
  canEdit: boolean;
}

function DirNode({ name, nodes, slug, canEdit }: DirNodeProps) {
  return (
    <li className="border-l border-rule">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-2 py-1.5 pl-3 transition hover:bg-rule/40">
          <ChevronRight
            size={14}
            className="shrink-0 text-muted transition group-open:rotate-90"
            aria-hidden
          />
          <FolderIcon size={14} className="shrink-0 text-muted" aria-hidden />
          <span className="font-mono text-sm text-ink">{name}/</span>
          <span className="font-mono text-[11px] text-muted">
            {nodes.length} {nodes.length === 1 ? "item" : "items"}
          </span>
        </summary>
        <ul className="ml-4 mt-1 space-y-0.5">
          {nodes.map((child) =>
            child.kind === "dir" ? (
              <DirNode
                key={child.name}
                name={child.name}
                nodes={child.children}
                slug={slug}
                canEdit={canEdit}
              />
            ) : (
              <FileNode
                key={child.name}
                name={child.name}
                file={child.file}
                slug={slug}
                canEdit={canEdit}
              />
            ),
          )}
        </ul>
      </details>
    </li>
  );
}

interface Props {
  slug: string;
  files: SkillFile[];
  canEdit: boolean;
}

export default function SkillFilesTree({ slug, files, canEdit }: Props) {
  const tree = buildTree(files);
  if (tree.length === 0) return null;
  return (
    <ul className="space-y-0.5">
      {tree.map((node) =>
        node.kind === "dir" ? (
          <DirNode
            key={node.name}
            name={node.name}
            nodes={node.children}
            slug={slug}
            canEdit={canEdit}
          />
        ) : (
          <FileNode
            key={node.name}
            name={node.name}
            file={node.file}
            slug={slug}
            canEdit={canEdit}
          />
        ),
      )}
    </ul>
  );
}
