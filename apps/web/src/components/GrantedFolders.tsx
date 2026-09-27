import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FileText, FolderOpen, Loader2, Plus, X } from "lucide-react";
import { FolderPicker } from "~/components/FolderPicker";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { apiGet, apiSend } from "~/lib/api";

interface UserFolder {
  path: string;
  label: string;
  kind: "folder" | "file";
  addedAt: string;
  exists: boolean;
}

/**
 * The folders this device lets Labee read and write. Adding one puts every
 * protocol inside it into the library — listed, searchable, and editable — and
 * new protocols can be saved there. Removing one only forgets the folder; the
 * files are left exactly where they are.
 */
export function GrantedFolders() {
  const qc = useQueryClient();
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<string>("");

  const foldersQ = useQuery({
    queryKey: ["folders"],
    queryFn: () => apiGet<{ folders: UserFolder[] }>("/api/folders"),
  });
  const folders = foldersQ.data?.folders ?? [];

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["folders"] });
    // The artifact library and its search index both change when a folder is
    // granted or revoked.
    void qc.invalidateQueries({ queryKey: ["skills"] });
    void qc.invalidateQueries({ queryKey: ["protocol-categories"] });
    void qc.invalidateQueries({ queryKey: ["protocol-index-status"] });
  };

  const add = useMutation({
    mutationFn: (path: string) => apiSend<{ folder: UserFolder }>("POST", "/api/folders", { path }),
    onSuccess: () => {
      setPicking(false);
      setChosen("");
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (path: string) =>
      apiSend<{ ok: true }>("DELETE", `/api/folders?path=${encodeURIComponent(path)}`),
    onSuccess: refresh,
  });
  const err = add.error ?? remove.error;

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg text-ink">What Labee can use</h2>
          <p className="mt-1 max-w-xl text-sm text-ink-light">
            Add a folder of protocols, or a single document. Whatever you add appears in your
            library, is indexed for search, and can be edited here. Nothing outside this list is
            read.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setPicking(true)}>
          <Plus className="size-4" />
          Add
        </Button>
      </div>

      <Dialog
        open={picking}
        onOpenChange={(open: boolean) => {
          setPicking(open);
          if (!open) {
            setChosen("");
            add.reset();
          }
        }}
      >
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add a folder or document</DialogTitle>
            <DialogDescription>
              Browse to a folder of protocols, or pick a single .md, .markdown, .txt or .rst file.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <FolderPicker allowFiles value={chosen} onSelect={(p) => setChosen(p)} />
            {chosen ? (
              <p className="mt-3 truncate font-mono text-xs text-ink-light" title={chosen}>
                Selected: {chosen}
              </p>
            ) : (
              <p className="mt-3 text-xs text-ink-faint">
                Click a document to choose it, or use the button below to take the folder you are in.
              </p>
            )}
            {add.error ? (
              <p className="mt-2 text-sm text-destructive">
                {add.error instanceof Error ? add.error.message : "Could not add that."}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button
              disabled={!chosen.trim() || add.isPending}
              onClick={() => add.mutate(chosen.trim())}
            >
              {add.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Add
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      {err ? (
        <p className="mt-3 text-sm text-destructive">
          {err instanceof Error ? err.message : "Something went wrong."}
        </p>
      ) : null}

      {foldersQ.isLoading ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-ink-light">
          <Loader2 className="size-3.5 animate-spin" />
          Loading…
        </p>
      ) : folders.length === 0 ? (
        <p className="mt-4 text-sm text-ink-light">
          Nothing added yet. Add the folder your protocols live in, or a single document, and it
          will show up in Protocols.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {folders.map((f) => (
            <li key={f.path} className="flex items-center gap-3 py-2.5">
              {f.kind === "file" ? (
                <FileText className="size-4 shrink-0 text-ink-faint" />
              ) : (
                <FolderOpen className="size-4 shrink-0 text-ink-faint" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-ink">{f.label}</span>
                <span className="block truncate font-mono text-xs text-ink-light">{f.path}</span>
              </span>
              {!f.exists && (
                <span
                  className="flex shrink-0 items-center gap-1 text-xs text-destructive"
                  title="This folder has been moved or deleted"
                >
                  <AlertTriangle className="size-3.5" />
                  Missing
                </span>
              )}
              <button
                type="button"
                aria-label={`Remove ${f.label}`}
                title="Stop using this folder. The files are left alone."
                disabled={remove.isPending}
                onClick={() => remove.mutate(f.path)}
                className="shrink-0 rounded p-1.5 text-ink-light transition hover:bg-muted hover:text-ink"
              >
                <X className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
