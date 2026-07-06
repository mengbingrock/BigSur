import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { FsBrowse } from "@labee/contracts";
import {
  Check,
  ChevronUp,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  Loader2,
  Plus,
} from "lucide-react";

import { apiGet, apiSend } from "~/lib/api";
import { desktopBridge } from "~/lib/desktop";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";

function browse(path?: string): Promise<FsBrowse> {
  const qs = path ? "?path=" + encodeURIComponent(path) : "";
  return apiGet<FsBrowse>("/api/fs/browse" + qs);
}

interface FolderPickerProps {
  value?: string;
  onSelect: (absPath: string) => void;
  title?: string;
  className?: string;
  /** Multi-add mode: add folders without closing, mark already-added ones. */
  multi?: boolean;
  /** Paths already added (multi mode) — shown with a check. */
  selected?: readonly string[];
  /** Called when the user finishes adding (multi mode). */
  onDone?: () => void;
}

/**
 * Inline panel that browses the user's computer via GET /api/fs/browse.
 * Starts at the chosen `value` (or home when empty), lets the user walk up/into
 * folders, paste an absolute path, and confirm with "Use this folder".
 *
 * In `multi` mode each subfolder can be added directly from the list and the
 * panel stays open so several folders can be added in a row.
 */
export function FolderPicker({
  value,
  onSelect,
  title,
  className,
  multi = false,
  selected = [],
  onDone,
}: FolderPickerProps) {
  // The directory currently being browsed. `undefined` → server starts at home.
  const [path, setPath] = useState<string | undefined>(value || undefined);
  const [pathInput, setPathInput] = useState(value ?? "");
  const [newFolder, setNewFolder] = useState<string | null>(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["fs-browse", path ?? "@home"],
    queryFn: () => browse(path),
  });

  const currentDir = data?.path ?? path;
  const mkdir = useMutation({
    mutationFn: (name: string) =>
      apiSend<{ path: string }>("POST", "/api/fs/mkdir", { path: currentDir, name }),
    onSuccess: (res) => {
      setNewFolder(null);
      setPath(res.path); // step into the new folder
      void refetch();
    },
  });

  // Keep the path input in sync with wherever we actually landed.
  useEffect(() => {
    if (data?.path) setPathInput(data.path);
  }, [data?.path]);

  const currentPath = data?.path ?? path ?? "";

  // In the desktop app, prefer the native OS folder dialog (can reach anywhere,
  // not just under home). Falls back to the inline browser below.
  const nativePick = desktopBridge()?.pickFolder;
  const pickNative = async () => {
    const picked = await nativePick?.(currentPath || value || undefined);
    if (picked) onSelect(picked);
  };

  return (
    <div className={cn("rounded-lg border border-border bg-card", className)}>
      {title ? (
        <div className="border-border border-b px-3 py-2 font-medium text-ink text-sm">{title}</div>
      ) : null}

      <div className="flex items-center gap-2 border-border border-b px-3 py-2">
        <Button
          size="icon-sm"
          variant="outline"
          aria-label="Up one folder"
          disabled={!data?.parent}
          onClick={() => data?.parent && setPath(data.parent)}
        >
          <ChevronUp />
        </Button>
        <Input
          nativeInput
          size="sm"
          value={pathInput}
          placeholder="/absolute/path"
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && pathInput.trim()) setPath(pathInput.trim());
          }}
          className="font-mono text-xs"
        />
        <Button size="sm" variant="outline" onClick={() => pathInput.trim() && setPath(pathInput.trim())}>
          Go
        </Button>
        {nativePick ? (
          <Button size="sm" variant="outline" onClick={() => void pickNative()} title="Open the native folder picker">
            <FolderSearch className="size-4" />
            Browse…
          </Button>
        ) : null}
      </div>

      <div className="flex items-center gap-2 border-border border-b px-3 py-1.5">
        {newFolder === null ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={!currentDir}
            onClick={() => setNewFolder("")}
          >
            <FolderPlus className="size-3.5" />
            New folder
          </Button>
        ) : (
          <>
            <Input
              nativeInput
              size="sm"
              autoFocus
              value={newFolder}
              placeholder="folder-name"
              onChange={(e) => setNewFolder(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newFolder.trim()) mkdir.mutate(newFolder.trim());
                if (e.key === "Escape") setNewFolder(null);
              }}
              className="text-xs"
            />
            <Button
              size="xs"
              disabled={!newFolder.trim() || mkdir.isPending}
              onClick={() => newFolder.trim() && mkdir.mutate(newFolder.trim())}
            >
              {mkdir.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Create
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setNewFolder(null)}>
              Cancel
            </Button>
          </>
        )}
        {mkdir.isError ? (
          <span className="text-destructive text-xs">Couldn’t create folder.</span>
        ) : null}
      </div>

      <div className="max-h-64 overflow-y-auto px-2 py-2">
        {isLoading ? (
          <div className="flex items-center gap-2 px-2 py-3 text-ink-light text-sm">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : isError ? (
          <div className="px-2 py-3 text-destructive text-sm">
            {error instanceof Error ? error.message : "Could not read this folder."}
          </div>
        ) : data && data.dirs.length === 0 ? (
          <div className="px-2 py-3 text-ink-faint text-sm">No subfolders here.</div>
        ) : (
          <ul className="flex flex-col">
            {data?.dirs.map((dir) => {
              const added = selected.includes(dir.path);
              return (
                <li key={dir.path} className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setPath(dir.path)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-ink text-sm transition hover:bg-surface"
                  >
                    <Folder className="size-4 shrink-0 text-ink-light" />
                    <span className="truncate">{dir.name}</span>
                  </button>
                  {multi ? (
                    added ? (
                      <span className="flex items-center gap-1 px-2 text-[11px] text-ink-faint">
                        <Check className="size-3 text-brand" /> added
                      </span>
                    ) : (
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Add ${dir.name}`}
                        title="Add this folder"
                        onClick={() => onSelect(dir.path)}
                      >
                        <Plus />
                      </Button>
                    )
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-border border-t px-3 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-ink-light text-xs" title={currentPath}>
          {currentPath || "—"}
        </span>
        {multi ? (
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!currentPath || selected.includes(currentPath)}
              onClick={() => currentPath && onSelect(currentPath)}
            >
              <Plus className="size-4" />
              Add this folder
            </Button>
            {onDone ? (
              <Button size="sm" onClick={onDone}>
                Done
              </Button>
            ) : null}
          </div>
        ) : (
          <Button
            size="sm"
            disabled={!currentPath}
            onClick={() => currentPath && onSelect(currentPath)}
          >
            <FolderOpen className="size-4" />
            Use this folder
          </Button>
        )}
      </div>
    </div>
  );
}
