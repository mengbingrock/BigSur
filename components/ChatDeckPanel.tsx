"use client";

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  forwardRef,
} from "react";
import {
  Download,
  FolderPlus,
  Folder,
  Loader2,
  Pencil,
  Trash2,
  Upload,
  Check,
  X as XIcon,
  ChevronRight,
  ChevronDown,
  Square,
  SquareCheck,
  FileCheck,
} from "lucide-react";
import { formatBytes, type DeckFile } from "@/lib/deck-shared";

interface Props {
  initialFiles: DeckFile[];
  maxBytes: number;
  /** Qualified paths (e.g. "notes.md" or "experiments/run1.md") of files
   *  whose contents the user has chosen to inject into the LLM context. */
  selectedFiles: Set<string>;
  onToggleFile: (qualifiedPath: string) => void;
}

export interface ChatDeckPanelHandle {
  /** Re-fetch the file list. Call after each chat turn so the model's writes appear. */
  refresh: () => Promise<void>;
}

interface UploadResult {
  uploaded: DeckFile[];
  failed: { name: string; error: string }[];
}

const ChatDeckPanel = forwardRef<ChatDeckPanelHandle, Props>(function ChatDeckPanel(
  { initialFiles, maxBytes, selectedFiles, onToggleFile },
  ref,
) {
  const [entries, setEntries] = useState<DeckFile[]>(initialFiles);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [creatingDir, setCreatingDir] = useState(false);
  const [newDirName, setNewDirName] = useState("");
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [dragOverDir, setDragOverDir] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());
  const [dirContents, setDirContents] = useState<Record<string, DeckFile[]>>({});
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set());
  const inputRef = useRef<HTMLInputElement | null>(null);

  const DRAG_MIME = "application/x-monterey-deck-entry";

  const fetchDirContents = useCallback(async (dirName: string) => {
    setLoadingDirs((prev) => {
      const n = new Set(prev);
      n.add(dirName);
      return n;
    });
    try {
      const res = await fetch(
        `/api/deck/dir/${encodeURIComponent(dirName)}`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `List failed (HTTP ${res.status})`);
      }
      const data = (await res.json()) as { files: DeckFile[] };
      setDirContents((prev) => ({ ...prev, [dirName]: data.files }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "List failed.");
    } finally {
      setLoadingDirs((prev) => {
        const n = new Set(prev);
        n.delete(dirName);
        return n;
      });
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/deck", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { files: DeckFile[] };
      setEntries(data.files);
      // After a top-level refresh, re-pull contents of any folders that
      // are still expanded — moves and uploads-into-folder may have changed
      // their contents.
      const stillThere = new Set(
        data.files.filter((f) => f.kind === "dir").map((f) => f.name),
      );
      setExpandedDirs((prev) => {
        const n = new Set<string>();
        for (const name of prev) if (stillThere.has(name)) n.add(name);
        return n;
      });
      // Drop cached contents for folders that no longer exist.
      let toRefetch: string[] = [];
      setDirContents((prev) => {
        const out: Record<string, DeckFile[]> = {};
        for (const [k, v] of Object.entries(prev)) {
          if (stillThere.has(k)) out[k] = v;
        }
        // Anything still expanded should be refetched (contents may have
        // changed via move/upload-into).
        toRefetch = Array.from(stillThere).filter((d) => out[d] !== undefined);
        return out;
      });
      for (const d of toRefetch) {
        // fire-and-forget; loading states make this safe to overlap
        void fetchDirContents(d);
      }
    } catch {
      // silent
    }
  }, [fetchDirContents]);

  const toggleDir = useCallback(
    (dirName: string) => {
      setExpandedDirs((prev) => {
        const n = new Set(prev);
        if (n.has(dirName)) {
          n.delete(dirName);
        } else {
          n.add(dirName);
          // Lazy-load contents on first expand. Subsequent expands reuse cache.
          if (dirContents[dirName] === undefined) {
            fetchDirContents(dirName);
          }
        }
        return n;
      });
    },
    [dirContents, fetchDirContents],
  );

  useImperativeHandle(ref, () => ({ refresh }), [refresh]);

  useEffect(() => {
    setEntries(initialFiles);
  }, [initialFiles]);

  const upload = useCallback(
    async (selected: FileList | File[], subdir?: string) => {
      const list = Array.from(selected);
      if (list.length === 0) return;
      const tooBig = list.find((f) => f.size > maxBytes);
      if (tooBig) {
        setError(
          `${tooBig.name} is ${formatBytes(tooBig.size)} (max ${formatBytes(maxBytes)})`,
        );
        return;
      }
      setError(null);
      setUploading(true);
      try {
        const fd = new FormData();
        for (const f of list) fd.append("file", f, f.name);
        if (subdir) fd.append("subdir", subdir);
        const res = await fetch("/api/deck", { method: "POST", body: fd });
        const data = (await res.json()) as UploadResult | { error?: string };
        if (!res.ok && "error" in data && res.status !== 207) {
          throw new Error(data.error ?? `Upload failed (HTTP ${res.status})`);
        }
        const result = data as UploadResult;
        if (result.failed?.length) {
          setError(result.failed[0].error);
        }
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed.");
      } finally {
        setUploading(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [maxBytes, refresh],
  );

  async function moveIntoDir(name: string, intoDir: string) {
    if (name === intoDir) return;
    setError(null);
    try {
      const res = await fetch(`/api/deck/${encodeURIComponent(name)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intoDir }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Move failed (HTTP ${res.status})`);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Move failed.");
    }
  }

  async function onCreateDir() {
    const name = newDirName.trim();
    if (!name) return;
    setError(null);
    try {
      const res = await fetch("/api/deck/dir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Create failed (HTTP ${res.status})`);
      }
      setCreatingDir(false);
      setNewDirName("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed.");
    }
  }

  async function onDelete(qualifiedPath: string, kind: "file" | "dir") {
    const noun = kind === "dir" ? "folder" : "file";
    const detail = kind === "dir" ? " and everything inside it" : "";
    if (!confirm(`Delete ${noun} "${qualifiedPath}"${detail}?`)) return;
    setError(null);
    try {
      const res = await fetch(
        `/api/deck/${encodeURIComponent(qualifiedPath)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Delete failed (HTTP ${res.status})`);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed.");
    }
  }

  function startRename(qualifiedPath: string, currentBareName: string) {
    setRenamingPath(qualifiedPath);
    setRenameDraft(currentBareName);
    setError(null);
  }

  function cancelRename() {
    setRenamingPath(null);
    setRenameDraft("");
  }

  async function saveAsProtocol(qualifiedPath: string) {
    const filename = qualifiedPath.split("/").pop() || qualifiedPath;
    const suggested = filename
      .replace(/\.[^./\\]+$/, "")
      .replace(/[_\-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const name = window.prompt(
      `Save "${filename}" as a new protocol. Name:`,
      suggested,
    );
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Protocol name cannot be empty.");
      return;
    }
    setError(null);
    try {
      const res = await fetch("/api/artifacts/from-deck-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deckPath: qualifiedPath, name: trimmed }),
      });
      const raw = await res.text();
      let data: { skill?: { slug?: string; name?: string }; error?: string } = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        // body wasn't JSON — fall through and use raw text as the message
      }
      if (!res.ok || !data.skill) {
        const detail =
          data.error ??
          (raw && raw.length < 500
            ? raw.replace(/<[^>]+>/g, "").trim()
            : null) ??
          `HTTP ${res.status}`;
        throw new Error(`Save failed: ${detail}`);
      }
      const open = confirm(
        `Saved as protocol "${data.skill.name ?? trimmed}". Open it now?`,
      );
      if (open && data.skill.slug) {
        window.location.assign(`/skills/${data.skill.slug}`);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not save protocol.",
      );
    }
  }

  async function commitRename(oldQualifiedPath: string, currentBareName: string) {
    const newName = renameDraft.trim();
    if (!newName || newName === currentBareName) {
      cancelRename();
      return;
    }
    setError(null);
    try {
      const res = await fetch(
        `/api/deck/${encodeURIComponent(oldQualifiedPath)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ newName }),
        },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Rename failed (HTTP ${res.status})`);
      }
      cancelRename();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rename failed.");
    }
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs uppercase tracking-[0.18em] text-muted">
          Working directory
        </p>
        {!creatingDir && (
          <button
            type="button"
            onClick={() => {
              setCreatingDir(true);
              setNewDirName("");
              setError(null);
            }}
            className="inline-flex items-center gap-1 text-xs text-muted transition hover:text-ink"
            title="New folder"
          >
            <FolderPlus size={12} /> Folder
          </button>
        )}
      </div>
      <p className="mb-3 text-xs leading-relaxed text-muted">
        Mounted as <code className="font-mono">./deck/</code> in the chat
        workspace. Files persist across sessions; folders organize them. Tick
        a file&apos;s checkbox to inject its contents into the next prompt.
      </p>

      {creatingDir && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onCreateDir();
          }}
          className="mb-3 flex flex-col gap-2"
        >
          <input
            autoFocus
            value={newDirName}
            onChange={(e) => setNewDirName(e.target.value)}
            placeholder="Folder name"
            maxLength={255}
            className="w-full border border-rule bg-paper px-2 py-1 text-sm text-ink focus:border-ink focus:outline-none"
          />
          <div className="flex items-center gap-2 text-xs">
            <button
              type="submit"
              className="border border-ink bg-ink px-3 py-1 text-paper transition hover:opacity-90"
            >
              Create
            </button>
            <button
              type="button"
              onClick={() => {
                setCreatingDir(false);
                setNewDirName("");
              }}
              className="text-muted transition hover:text-ink"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = e.dataTransfer.types.includes(DRAG_MIME)
            ? "move"
            : "copy";
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          // Internal drag from a child row → move out of its parent folder.
          const moveSrc = e.dataTransfer.getData(DRAG_MIME);
          if (moveSrc && moveSrc.includes("/")) {
            moveIntoDir(moveSrc, "");
            return;
          }
          if (moveSrc) {
            // Top-level row dropped on root — no-op.
            return;
          }
          if (e.dataTransfer.files?.length) upload(e.dataTransfer.files);
        }}
        className={`flex flex-col items-center justify-center gap-1 border-2 border-dashed px-3 py-4 text-center text-xs transition ${
          dragOver
            ? "border-ink bg-ink/5"
            : uploading
              ? "border-rule opacity-70"
              : "border-rule hover:border-ink"
        }`}
      >
        {uploading ? (
          <>
            <Loader2 size={14} className="animate-spin text-muted" />
            <span className="text-muted">Uploading…</span>
          </>
        ) : (
          <>
            <Upload size={14} className="text-muted" />
            <span className="text-ink">
              Drop a file or{" "}
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="underline underline-offset-2 transition hover:text-ink"
              >
                browse
              </button>
            </span>
            <span className="text-[10px] text-muted">max {formatBytes(maxBytes)}</span>
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) upload(e.target.files);
          }}
        />
      </div>

      {error && <p className="mt-2 text-[11px] text-red-700">{error}</p>}

      <ul className="mt-3 flex flex-col gap-1">
        {entries.length === 0 ? (
          <li className="text-[11px] text-muted">(Empty.)</li>
        ) : (
          entries.flatMap((f) => {
            const isDir = f.kind === "dir";
            const qualifiedPath = f.name; // top-level: qualified === bare
            const isRenaming = renamingPath === qualifiedPath;
            const isDropTarget = isDir && dragOverDir === f.name;
            const isExpanded = isDir && expandedDirs.has(f.name);
            const isLoading = isDir && loadingDirs.has(f.name);

            // Per-row event handlers. Folders accept drops; non-folders are
            // draggable so the user can pick them up and move into a folder.
            const folderDropHandlers = isDir
              ? {
                  onDragOver: (e: React.DragEvent<HTMLLIElement>) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = e.dataTransfer.types.includes(
                      DRAG_MIME,
                    )
                      ? "move"
                      : "copy";
                    if (dragOverDir !== f.name) setDragOverDir(f.name);
                  },
                  onDragLeave: () => {
                    if (dragOverDir === f.name) setDragOverDir(null);
                  },
                  onDrop: (e: React.DragEvent<HTMLLIElement>) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDragOverDir(null);
                    const moveSrc = e.dataTransfer.getData(DRAG_MIME);
                    if (moveSrc) {
                      moveIntoDir(moveSrc, f.name);
                      return;
                    }
                    if (e.dataTransfer.files?.length) {
                      upload(e.dataTransfer.files, f.name);
                    }
                  },
                }
              : {};

            const fileDragHandlers = !isDir
              ? {
                  draggable: !isRenaming,
                  onDragStart: (e: React.DragEvent<HTMLLIElement>) => {
                    e.dataTransfer.setData(DRAG_MIME, f.name);
                    e.dataTransfer.setData("text/plain", f.name);
                    e.dataTransfer.effectAllowed = "move";
                  },
                }
              : {};

            const rowEl = (
              <li
                key={f.name}
                {...folderDropHandlers}
                {...fileDragHandlers}
                className={`group flex items-center gap-2 rounded-sm px-2 py-1.5 transition ${
                  isDropTarget
                    ? "bg-ink/10 ring-1 ring-ink"
                    : "hover:bg-ink/5"
                } ${!isDir && !isRenaming ? "cursor-grab active:cursor-grabbing" : ""}`}
              >
                {isDir ? (
                  <>
                    <button
                      type="button"
                      onClick={() => toggleDir(f.name)}
                      className="shrink-0 text-muted transition hover:text-ink"
                      title={isExpanded ? "Collapse" : "Expand"}
                      aria-label={isExpanded ? "Collapse" : "Expand"}
                    >
                      {isExpanded ? (
                        <ChevronDown size={12} />
                      ) : (
                        <ChevronRight size={12} />
                      )}
                    </button>
                    <Folder size={13} className="shrink-0 text-ink" />
                  </>
                ) : null}
                {isRenaming ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      commitRename(qualifiedPath, f.name);
                    }}
                    className="flex flex-1 items-center gap-1"
                  >
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          e.preventDefault();
                          cancelRename();
                        }
                      }}
                      maxLength={255}
                      className="flex-1 min-w-0 border border-rule bg-paper px-1.5 py-0.5 font-mono text-xs text-ink focus:border-ink focus:outline-none"
                    />
                    <button
                      type="submit"
                      className="text-ink transition hover:opacity-70"
                      title="Save"
                    >
                      <Check size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={cancelRename}
                      className="text-muted transition hover:text-ink"
                      title="Cancel"
                    >
                      <XIcon size={12} />
                    </button>
                  </form>
                ) : (
                  <>
                    {!isDir && (
                      <button
                        type="button"
                        onClick={() => onToggleFile(qualifiedPath)}
                        className="shrink-0 text-ink transition hover:opacity-70"
                        title={
                          selectedFiles.has(qualifiedPath)
                            ? "Remove from prompt context"
                            : "Add file contents to next prompt"
                        }
                      >
                        {selectedFiles.has(qualifiedPath) ? (
                          <SquareCheck size={13} />
                        ) : (
                          <Square size={13} />
                        )}
                      </button>
                    )}
                    <span className="flex-1 min-w-0">
                      <span
                        className="block truncate font-mono text-xs text-ink"
                        title={f.name}
                      >
                        {f.name}
                      </span>
                      <span className="text-[10px] text-muted">
                        {isDir ? "folder" : formatBytes(f.size)}
                      </span>
                    </span>
                    {!isDir && (
                      <a
                        href={`/api/deck/${encodeURIComponent(f.name)}`}
                        download={f.name}
                        className="text-muted opacity-0 transition group-hover:opacity-100 hover:text-ink"
                        title="Download"
                      >
                        <Download size={12} />
                      </a>
                    )}
                    {!isDir && (
                      <button
                        type="button"
                        onClick={() => saveAsProtocol(qualifiedPath)}
                        className="text-muted opacity-0 transition group-hover:opacity-100 hover:text-ink"
                        title="Save as protocol"
                      >
                        <FileCheck size={12} />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => startRename(qualifiedPath, f.name)}
                      className="text-muted opacity-0 transition group-hover:opacity-100 hover:text-ink"
                      title="Rename"
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(qualifiedPath, f.kind)}
                      className="text-muted opacity-0 transition group-hover:opacity-100 hover:text-red-700"
                      title="Delete"
                    >
                      <Trash2 size={12} />
                    </button>
                  </>
                )}
              </li>
            );

            if (!isDir || !isExpanded) return [rowEl];

            const children = dirContents[f.name];
            const childRows: React.ReactNode[] = [];
            if (isLoading && children === undefined) {
              childRows.push(
                <li
                  key={`${f.name}::loading`}
                  className="flex items-center gap-2 pl-7 pr-2 py-1 text-[11px] text-muted"
                >
                  <Loader2 size={11} className="animate-spin" /> Loading…
                </li>,
              );
            } else if (children && children.length === 0) {
              childRows.push(
                <li
                  key={`${f.name}::empty`}
                  className="pl-7 pr-2 py-1 text-[11px] text-muted"
                >
                  (Empty folder.)
                </li>,
              );
            } else if (children) {
              for (const c of children) {
                const childIsDir = c.kind === "dir";
                const childQualified = `${f.name}/${c.name}`;
                const childIsRenaming = renamingPath === childQualified;
                childRows.push(
                  <li
                    key={`${f.name}::${c.name}`}
                    draggable={!childIsDir && !childIsRenaming}
                    onDragStart={(e) => {
                      if (childIsDir) return;
                      e.dataTransfer.setData(DRAG_MIME, childQualified);
                      e.dataTransfer.setData("text/plain", c.name);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    className={`group flex items-center gap-2 rounded-sm pl-7 pr-2 py-1 transition hover:bg-ink/5 ${
                      !childIsDir && !childIsRenaming
                        ? "cursor-grab active:cursor-grabbing"
                        : ""
                    }`}
                  >
                    {childIsDir ? (
                      <Folder size={12} className="shrink-0 text-ink" />
                    ) : null}
                    {childIsRenaming ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          commitRename(childQualified, c.name);
                        }}
                        className="flex flex-1 items-center gap-1"
                      >
                        <input
                          autoFocus
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") {
                              e.preventDefault();
                              cancelRename();
                            }
                          }}
                          maxLength={255}
                          className="flex-1 min-w-0 border border-rule bg-paper px-1.5 py-0.5 font-mono text-[11px] text-ink focus:border-ink focus:outline-none"
                        />
                        <button
                          type="submit"
                          className="text-ink transition hover:opacity-70"
                          title="Save"
                        >
                          <Check size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={cancelRename}
                          className="text-muted transition hover:text-ink"
                          title="Cancel"
                        >
                          <XIcon size={12} />
                        </button>
                      </form>
                    ) : (
                      <>
                        {!childIsDir && (
                          <button
                            type="button"
                            onClick={() => onToggleFile(childQualified)}
                            className="shrink-0 text-ink transition hover:opacity-70"
                            title={
                              selectedFiles.has(childQualified)
                                ? "Remove from prompt context"
                                : "Add file contents to next prompt"
                            }
                          >
                            {selectedFiles.has(childQualified) ? (
                              <SquareCheck size={12} />
                            ) : (
                              <Square size={12} />
                            )}
                          </button>
                        )}
                        <span className="flex-1 min-w-0">
                          <span
                            className="block truncate font-mono text-[11px] text-ink"
                            title={c.name}
                          >
                            {c.name}
                          </span>
                          <span className="text-[10px] text-muted">
                            {childIsDir ? "folder" : formatBytes(c.size)}
                          </span>
                        </span>
                        {!childIsDir && (
                          <a
                            href={`/api/deck/${encodeURIComponent(childQualified)}`}
                            download={c.name}
                            className="text-muted opacity-0 transition group-hover:opacity-100 hover:text-ink"
                            title="Download"
                          >
                            <Download size={12} />
                          </a>
                        )}
                        {!childIsDir && (
                          <button
                            type="button"
                            onClick={() => saveAsProtocol(childQualified)}
                            className="text-muted opacity-0 transition group-hover:opacity-100 hover:text-ink"
                            title="Save as protocol"
                          >
                            <FileCheck size={12} />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => startRename(childQualified, c.name)}
                          className="text-muted opacity-0 transition group-hover:opacity-100 hover:text-ink"
                          title="Rename"
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDelete(childQualified, c.kind)}
                          className="text-muted opacity-0 transition group-hover:opacity-100 hover:text-red-700"
                          title="Delete"
                        >
                          <Trash2 size={12} />
                        </button>
                      </>
                    )}
                  </li>,
                );
              }
            }
            return [rowEl, ...childRows];
          })
        )}
      </ul>
    </div>
  );
});

export default ChatDeckPanel;
