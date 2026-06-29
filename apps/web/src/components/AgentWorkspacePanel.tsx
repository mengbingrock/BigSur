import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  FolderOpen,
  Library,
  RefreshCw,
} from "lucide-react";
import type { Agent, DeckFile } from "@labee/contracts";
import { apiGet } from "~/lib/api";
import { formatBytes } from "@labee/shared/format";
import { cn } from "~/lib/utils";

interface Root {
  kind: "working" | "reference";
  label: string;
  path: string;
}

/** Read-only view of an active agent's working directory + reference folders.
 *  Files the model writes land in the working directory and appear here. */
export function AgentWorkspacePanel({
  agent,
  streaming,
}: {
  agent: Agent;
  streaming: boolean;
}) {
  const rootsQ = useQuery({
    queryKey: ["agent-roots", agent.id],
    queryFn: () => apiGet<{ roots: Root[] }>(`/api/agents/${agent.id}/roots`),
  });
  const roots = rootsQ.data?.roots ?? [];
  const working = roots.find((r) => r.kind === "working");
  const references = roots.filter((r) => r.kind === "reference");

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="mb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-ink-light">
          Working directory
        </h3>
        {working ? (
          <RootFiles agentId={agent.id} root={working} defaultOpen streaming={streaming} />
        ) : (
          <p className="text-xs text-ink-faint">No working directory configured.</p>
        )}
      </div>

      {references.length > 0 ? (
        <div>
          <h3 className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-light">
            Reference protocols
          </h3>
          <div className="mt-1 flex flex-col gap-1">
            {references.map((r) => (
              <RootFiles key={r.path} agentId={agent.id} root={r} streaming={streaming} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RootFiles({
  agentId,
  root,
  defaultOpen = false,
  streaming,
}: {
  agentId: string;
  root: Root;
  defaultOpen?: boolean;
  streaming: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const filesQ = useQuery({
    queryKey: ["agent-files", agentId, root.path, streaming],
    queryFn: () =>
      apiGet<{ path: string; files: DeckFile[] }>(
        `/api/agents/${agentId}/files?path=${encodeURIComponent(root.path)}`,
      ),
    enabled: open,
    // While the model is writing, refresh so new artifacts appear.
    refetchInterval: open && root.kind === "working" && streaming ? 2500 : false,
  });
  const files = filesQ.data?.files ?? [];

  const Icon = root.kind === "working" ? FolderOpen : Library;

  return (
    <div className="rounded-md border border-border bg-background/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-ink-faint" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-ink-faint" />
        )}
        <Icon className="size-3.5 shrink-0 text-ink-light" />
        <span className="min-w-0 flex-1 truncate text-xs text-ink" title={root.path}>
          {root.label}
        </span>
        {open ? (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              void filesQ.refetch();
            }}
            className="text-ink-faint transition hover:text-ink"
            title="Refresh"
          >
            <RefreshCw className={cn("size-3", filesQ.isFetching && "animate-spin")} />
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="border-t border-border px-2 py-1.5">
          <p className="mb-1 truncate font-mono text-[10px] text-ink-faint" title={root.path}>
            {root.path}
          </p>
          {filesQ.isLoading ? (
            <p className="text-xs text-ink-faint">Loading…</p>
          ) : files.length === 0 ? (
            <p className="text-xs text-ink-faint">(empty)</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {files.map((f) => (
                <li key={f.name} className="flex items-center gap-1.5 text-xs">
                  <span className="min-w-0 flex-1 truncate text-ink" title={f.name}>
                    {f.kind === "dir" ? `${f.name}/` : f.name}
                  </span>
                  {f.kind === "file" ? (
                    <>
                      <span className="shrink-0 text-[10px] text-ink-faint">
                        {formatBytes(f.size)}
                      </span>
                      <a
                        href={`/api/agents/${agentId}/download?path=${encodeURIComponent(
                          joinPath(root.path, f.name),
                        )}`}
                        className="shrink-0 text-ink-faint transition hover:text-brand"
                        title="Download"
                      >
                        <Download className="size-3" />
                      </a>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}
