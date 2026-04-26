"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from "react";
import { Download, Loader2, Trash2, Upload } from "lucide-react";
import { formatBytes, type DeckFile } from "@/lib/deck-shared";

interface Props {
  initialFiles: DeckFile[];
  maxBytes: number;
}

export interface ChatDeckPanelHandle {
  /** Re-fetch the file list. Call after each chat turn so the model's writes appear. */
  refresh: () => Promise<void>;
}

interface UploadResult {
  uploaded: DeckFile[];
  failed: { name: string; error: string }[];
}

/**
 * Compact file panel for the chat sidebar. Shows the user's deck files (the
 * same dir mounted into the chat workspace as ./deck/), with upload + delete.
 * Parent Chat component holds a ref so it can trigger refresh() when a chat
 * turn finishes.
 */
const ChatDeckPanel = forwardRef<ChatDeckPanelHandle, Props>(function ChatDeckPanel(
  { initialFiles, maxBytes },
  ref,
) {
  const [files, setFiles] = useState<DeckFile[]>(initialFiles);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/deck", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { files: DeckFile[] };
      setFiles(data.files);
    } catch {
      // silent — sidebar; user can click refresh implicitly via next turn
    }
  }, []);

  useImperativeHandle(ref, () => ({ refresh }), [refresh]);

  useEffect(() => {
    setFiles(initialFiles);
  }, [initialFiles]);

  const upload = useCallback(
    async (selected: FileList | File[]) => {
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

  async function onDelete(name: string) {
    if (!confirm(`Delete "${name}" from your deck?`)) return;
    setError(null);
    try {
      const res = await fetch(`/api/deck/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Delete failed (HTTP ${res.status})`);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed.");
    }
  }

  return (
    <div>
      <p className="mb-2 text-xs uppercase tracking-[0.18em] text-muted">
        Working directory
      </p>
      <p className="mb-3 text-xs leading-relaxed text-muted">
        Files here are mounted as <code className="font-mono">./deck/</code> in
        the chat workspace. Skills can read your uploads and write outputs that
        persist across sessions.
      </p>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
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

      {error && (
        <p className="mt-2 text-[11px] text-red-700">{error}</p>
      )}

      <ul className="mt-3 flex flex-col gap-1">
        {files.length === 0 ? (
          <li className="text-[11px] text-muted">(No files yet.)</li>
        ) : (
          files.map((f) => (
            <li
              key={f.name}
              className="group flex items-center gap-2 rounded-sm px-2 py-1.5 transition hover:bg-ink/5"
            >
              <span className="flex-1 min-w-0">
                <span className="block truncate font-mono text-xs text-ink" title={f.name}>
                  {f.name}
                </span>
                <span className="text-[10px] text-muted">
                  {formatBytes(f.size)}
                </span>
              </span>
              <a
                href={`/api/deck/${encodeURIComponent(f.name)}`}
                download={f.name}
                className="text-muted opacity-0 transition group-hover:opacity-100 hover:text-ink"
                title="Download"
              >
                <Download size={12} />
              </a>
              <button
                type="button"
                onClick={() => onDelete(f.name)}
                className="text-muted opacity-0 transition group-hover:opacity-100 hover:text-red-700"
                title="Delete"
              >
                <Trash2 size={12} />
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
});

export default ChatDeckPanel;
