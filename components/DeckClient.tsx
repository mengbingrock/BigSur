"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Download,
  Loader2,
  Trash2,
  Upload,
  RefreshCw,
} from "lucide-react";
import { formatBytes, type DeckFile } from "@/lib/deck-shared";

interface Props {
  initialFiles: DeckFile[];
  maxBytes: number;
}

interface UploadResult {
  uploaded: DeckFile[];
  failed: { name: string; error: string }[];
}

export default function DeckClient({ initialFiles, maxBytes }: Props) {
  const [files, setFiles] = useState<DeckFile[]>(initialFiles);
  const [uploading, setUploading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/deck", { cache: "no-store" });
      if (!res.ok) throw new Error(`Refresh failed (HTTP ${res.status})`);
      const data = (await res.json()) as { files: DeckFile[] };
      setFiles(data.files);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  const upload = useCallback(
    async (selected: FileList | File[]) => {
      const list = Array.from(selected);
      if (list.length === 0) return;

      const tooBig = list.find((f) => f.size > maxBytes);
      if (tooBig) {
        setError(
          `"${tooBig.name}" is ${formatBytes(tooBig.size)} — exceeds limit of ${formatBytes(
            maxBytes,
          )}.`,
        );
        return;
      }

      setError(null);
      setWarnings([]);
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
        if (result.failed && result.failed.length > 0) {
          setWarnings(result.failed.map((f) => `${f.name}: ${f.error}`));
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

  useEffect(() => {
    setFiles(initialFiles);
  }, [initialFiles]);

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
      {/* Upload zone */}
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
        className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed px-6 py-10 text-center transition ${
          dragOver
            ? "border-ink bg-ink/5"
            : uploading
              ? "border-rule bg-paper opacity-70"
              : "border-rule bg-paper hover:border-ink"
        }`}
      >
        <Upload size={20} className="text-muted" />
        <p className="text-sm text-ink">
          Drop files here or{" "}
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="underline underline-offset-2 transition hover:text-ink disabled:opacity-50"
          >
            choose from your computer
          </button>
        </p>
        <p className="text-[11px] text-muted">
          Up to {formatBytes(maxBytes)} per file
        </p>
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

      {(error || warnings.length > 0 || uploading) && (
        <div className="mt-4 space-y-2">
          {uploading && (
            <p className="flex items-center gap-2 text-sm text-muted">
              <Loader2 size={14} className="animate-spin" />
              Uploading…
            </p>
          )}
          {error && (
            <div className="border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
              {error}
            </div>
          )}
          {warnings.length > 0 && (
            <ul className="text-xs text-muted">
              {warnings.map((w, i) => (
                <li key={i}>⚠ {w}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* File list */}
      <div className="mt-10 flex items-center justify-between">
        <h2 className="text-xs uppercase tracking-[0.18em] text-muted">
          {files.length} file{files.length === 1 ? "" : "s"}
        </h2>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 text-xs text-muted transition hover:text-ink disabled:opacity-50"
        >
          {refreshing ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <RefreshCw size={12} />
          )}
          Refresh
        </button>
      </div>

      {files.length === 0 ? (
        <div className="mt-4 border border-dashed border-rule p-10 text-center text-sm text-muted">
          Your deck is empty. Drop a file above to get started.
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-rule border border-rule">
          {files.map((f) => (
            <li
              key={f.name}
              className="flex items-center justify-between gap-3 px-4 py-3 transition hover:bg-ink/5"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-sm text-ink">{f.name}</p>
                <p className="mt-1 text-[11px] text-muted">
                  {formatBytes(f.size)} ·{" "}
                  <time dateTime={f.modified}>
                    {new Date(f.modified).toLocaleString()}
                  </time>
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <a
                  href={`/api/deck/${encodeURIComponent(f.name)}`}
                  download={f.name}
                  className="inline-flex items-center gap-1 border border-rule px-2.5 py-1.5 text-xs text-muted transition hover:border-ink hover:text-ink"
                  title="Download"
                >
                  <Download size={12} />
                  Download
                </a>
                <button
                  type="button"
                  onClick={() => onDelete(f.name)}
                  className="inline-flex items-center gap-1 border border-rule px-2.5 py-1.5 text-xs text-muted transition hover:border-red-700 hover:text-red-700"
                  title="Delete"
                >
                  <Trash2 size={12} />
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
