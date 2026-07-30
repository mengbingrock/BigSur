import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import type { ResearchEventEnvelope } from "@labee/contracts";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleX,
  FileText,
  FlaskConical,
  Loader2,
  ShieldCheck,
  Square,
  X,
} from "lucide-react";

import {
  answerGate,
  artifactFileUrl,
  cancelRun,
  getRun,
  listArtifacts,
  listClaims,
  STAGES,
  stageLabel,
  statusTone,
  useRunEvents,
  type ArtifactRow,
  type ClaimRow,
} from "~/lib/research";
import { Markdown } from "~/components/Markdown";
import { Button } from "~/components/ui/button";

export const Route = createFileRoute("/research/$runId")({
  component: RunPage,
});

type Tab = "events" | "artifacts" | "claims" | "report";

function RunPage() {
  const { runId } = Route.useParams();
  const qc = useQueryClient();
  const live = useRunEvents(runId);

  const runQ = useQuery({
    queryKey: ["research-run", runId],
    queryFn: () => getRun(runId),
    refetchInterval: 8000,
  });
  const run = runQ.data?.run;
  const status = live.status ?? run?.status ?? "…";
  const stage = live.stage ?? run?.stage ?? null;
  const pendingGate = live.pendingGate ?? run?.pendingGates[0] ?? null;
  const isLive = ["queued", "running", "awaiting_gate"].includes(status);

  const cancel = useMutation({
    mutationFn: () => cancelRun(runId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["research-run", runId] }),
  });
  const gate = useMutation({
    mutationFn: (approve: boolean) => answerGate(runId, pendingGate ?? "", approve),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["research-run", runId] }),
  });

  const [tab, setTab] = useState<Tab>("events");
  useEffect(() => {
    if (status === "completed") setTab("report");
  }, [status]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-6 py-6">
      <Link to="/research" className="flex items-center gap-1 text-xs text-ink-light hover:text-ink">
        <ArrowLeft className="size-3.5" /> All runs
      </Link>

      <header className="flex flex-col gap-3 rounded-lg border border-rule bg-background/40 p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-lg font-semibold text-ink">
              <FlaskConical className="size-5 shrink-0 text-ink-light" />
              <span className="truncate">{run?.title ?? runId}</span>
            </h1>
            <p className="mt-1 text-sm text-ink-light">{run?.question}</p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className={`text-sm font-medium ${statusTone(status)}`}>{status}</span>
            <span className="tabular-nums text-xs text-ink-faint">
              ${run?.costUsd?.toFixed(2) ?? "0.00"}
            </span>
            {isLive ? (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                <Square className="size-3.5" /> Cancel
              </Button>
            ) : null}
          </div>
        </div>

        <StageStepper current={stage} status={status} />

        {run?.failReason ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            Failed closed: <span className="font-mono">{run.failReason}</span>
          </p>
        ) : null}

        {pendingGate ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
            <p className="text-sm text-ink">
              The run is paused at the <span className="font-mono">{pendingGate}</span> gate — review
              the brief in Artifacts, then approve to continue.
            </p>
            <div className="flex gap-2">
              <Button size="sm" className="gap-1.5" disabled={gate.isPending} onClick={() => gate.mutate(true)}>
                <Check className="size-3.5" /> Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={gate.isPending}
                onClick={() => gate.mutate(false)}
              >
                <X className="size-3.5" /> Reject
              </Button>
            </div>
          </div>
        ) : null}
      </header>

      <nav className="flex gap-1 border-b border-rule text-sm">
        {(
          [
            ["events", "Activity"],
            ["artifacts", "Artifacts"],
            ["claims", "Claims"],
            ["report", "Report"],
          ] as Array<[Tab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`px-3 py-2 transition ${
              tab === key ? "border-b-2 border-ink font-medium text-ink" : "text-ink-light hover:text-ink"
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "events" ? <EventFeed events={live.events} liveText={live.liveText} /> : null}
      {tab === "artifacts" ? <ArtifactBrowser runId={runId} /> : null}
      {tab === "claims" ? <ClaimInspector runId={runId} /> : null}
      {tab === "report" ? <FinalReport runId={runId} status={status} /> : null}
    </div>
  );
}

function StageStepper({ current, status }: { current: string | null; status: string }) {
  const currentIdx = current ? STAGES.indexOf(current as (typeof STAGES)[number]) : -1;
  return (
    <ol className="flex flex-wrap items-center gap-1 text-xs">
      {STAGES.map((stage, i) => {
        const done = status === "completed" || (currentIdx > i && currentIdx !== -1);
        const active = currentIdx === i && status !== "completed";
        return (
          <li key={stage} className="flex items-center gap-1">
            {i > 0 ? <ChevronRight className="size-3 text-ink-faint" /> : null}
            <span
              className={`rounded-full border px-2 py-0.5 ${
                done
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600"
                  : active
                    ? "border-sky-500/40 bg-sky-500/10 text-sky-600"
                    : "border-rule text-ink-faint"
              }`}
            >
              {stageLabel(stage)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function eventLine(evt: ResearchEventEnvelope): string {
  const d = evt.data as Record<string, unknown>;
  switch (evt.type) {
    case "run_status":
      return `run → ${String(d.status)}${d.failReason ? ` (${String(d.failReason)})` : ""}`;
    case "stage_started":
      return `stage started`;
    case "stage_finished":
      return `stage finished`;
    case "task_started":
      return `${evt.role ?? "agent"} started (${String(d.model ?? "")})`;
    case "task_finished":
      return d.ok
        ? `${evt.role ?? "agent"} finished ($${Number(d.costUsd ?? 0).toFixed(3)})`
        : `${evt.role ?? "agent"} FAILED: ${String(d.error ?? "")}`;
    case "gate_waiting":
      return `waiting for approval: ${String(d.gate)}`;
    case "gate_passed":
      return `gate passed: ${String(d.gate)}`;
    case "gate_failed":
      return `gate failed: ${String(d.gate)}`;
    case "artifact_created":
      return `artifact: ${String(d.relPath)}`;
    case "evidence_cached":
      return `evidence cached: ${String(d.refId ?? d.sourceTool)}`;
    case "claim_checked":
      return `claims (${String(d.pass)}): ${
        d.ratio !== undefined ? `grounding ${(Number(d.ratio) * 100).toFixed(1)}%, ` : ""
      }${d.blocking !== undefined ? `${String(d.blocking)} blocking, ` : ""}${
        d.flags !== undefined ? `${String(d.flags)} flags` : ""
      }`;
    case "eval_scored":
      return `eval ${evt.branch ?? ""}: ${d.score == null ? `error (${String(d.error ?? "")})` : `score ${String(d.score)}`}`;
    case "tree_updated":
      return `search tree updated (iteration ${String(d.iteration ?? d.round ?? "")})`;
    case "error":
      return `error: ${String(d.note ?? d.message ?? "")}`;
    default:
      return evt.type;
  }
}

function EventFeed({
  events,
  liveText,
}: {
  events: ResearchEventEnvelope[];
  liveText: Record<string, string>;
}) {
  const liveTasks = Object.entries(liveText).slice(-3);
  return (
    <div className="flex flex-col gap-3">
      {liveTasks.length > 0 ? (
        <div className="flex flex-col gap-2">
          {liveTasks.map(([taskId, text]) => (
            <div key={taskId} className="rounded-md border border-sky-500/30 bg-sky-500/5 p-3">
              <p className="mb-1 flex items-center gap-1.5 text-xs text-sky-600">
                <Loader2 className="size-3 animate-spin" /> streaming
              </p>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-xs text-ink-light">
                {text}
              </pre>
            </div>
          ))}
        </div>
      ) : null}
      <ol className="flex flex-col-reverse gap-0.5">
        {events.map((evt, i) => (
          <li
            key={evt.seq > 0 ? evt.seq : `live-${i}`}
            className="flex items-baseline gap-2 rounded px-2 py-1 font-mono text-xs text-ink-light odd:bg-background/40"
          >
            <span className="shrink-0 tabular-nums text-ink-faint">
              {new Date(evt.ts).toLocaleTimeString()}
            </span>
            {evt.stage ? (
              <span className="shrink-0 rounded bg-background px-1 text-[10px] uppercase text-ink-faint">
                {evt.stage}
              </span>
            ) : null}
            {evt.branch ? <span className="shrink-0 text-[10px] text-sky-600">{evt.branch}</span> : null}
            <span className="min-w-0 flex-1 break-words">{eventLine(evt)}</span>
          </li>
        ))}
      </ol>
      {events.length === 0 ? <p className="px-2 py-6 text-sm text-ink-faint">No events yet.</p> : null}
    </div>
  );
}

function ArtifactBrowser({ runId }: { runId: string }) {
  const artifactsQ = useQuery({
    queryKey: ["research-artifacts", runId],
    queryFn: () => listArtifacts(runId),
    refetchInterval: 10_000,
  });
  const [selected, setSelected] = useState<ArtifactRow | null>(null);
  const fileQ = useQuery({
    queryKey: ["research-artifact-file", runId, selected?.rel_path],
    queryFn: async () => {
      const res = await fetch(artifactFileUrl(runId, selected!.rel_path), { credentials: "include" });
      if (!res.ok) throw new Error("File unavailable.");
      return res.text();
    },
    enabled: !!selected,
  });
  const artifacts = artifactsQ.data?.artifacts ?? [];
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-[280px_1fr]">
      <ol className="flex max-h-[32rem] flex-col gap-0.5 overflow-auto rounded-md border border-rule p-1">
        {artifacts.map((artifact) => (
          <li key={artifact.id}>
            <button
              type="button"
              onClick={() => setSelected(artifact)}
              className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition ${
                selected?.id === artifact.id ? "bg-sidebar-accent text-ink" : "text-ink-light hover:bg-background/60"
              }`}
            >
              <FileText className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate font-mono">{artifact.rel_path}</span>
              <span className="shrink-0 text-[10px] uppercase text-ink-faint">{artifact.kind}</span>
            </button>
          </li>
        ))}
        {artifacts.length === 0 ? (
          <p className="px-2 py-4 text-xs text-ink-faint">No artifacts yet.</p>
        ) : null}
      </ol>
      <div className="max-h-[32rem] overflow-auto rounded-md border border-rule p-4">
        {!selected ? (
          <p className="text-sm text-ink-faint">Select an artifact to preview it.</p>
        ) : fileQ.isLoading ? (
          <Loader2 className="size-4 animate-spin text-ink-faint" />
        ) : selected.rel_path.endsWith(".md") ? (
          <Markdown>{fileQ.data ?? ""}</Markdown>
        ) : (
          <pre className="whitespace-pre-wrap font-mono text-xs text-ink-light">{fileQ.data}</pre>
        )}
      </div>
    </div>
  );
}

function ClaimInspector({ runId }: { runId: string }) {
  const claimsQ = useQuery({
    queryKey: ["research-claims", runId],
    queryFn: () => listClaims(runId),
    refetchInterval: 15_000,
  });
  const claims = claimsQ.data?.claims ?? [];
  const counts = useMemo(() => {
    const c = { supported: 0, partial: 0, unsupported: 0, dropped: 0 };
    for (const claim of claims) {
      if (claim.status in c) c[claim.status as keyof typeof c]++;
    }
    return c;
  }, [claims]);
  if (claims.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-rule px-4 py-8 text-center text-sm text-ink-faint">
        The claims ledger fills in during the final verification stage.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="flex items-center gap-3 text-xs text-ink-light">
        <ShieldCheck className="size-4 text-emerald-600" />
        {counts.supported} supported · {counts.partial} partial · {counts.unsupported} unsupported ·{" "}
        {counts.dropped} dropped
      </p>
      <ol className="flex flex-col gap-1">
        {claims.map((claim) => (
          <ClaimRowView key={claim.id} claim={claim} />
        ))}
      </ol>
    </div>
  );
}

function ClaimRowView({ claim }: { claim: ClaimRow }) {
  const tone =
    claim.status === "supported"
      ? "border-emerald-500/30"
      : claim.status === "partial"
        ? "border-amber-500/30"
        : "border-destructive/30";
  return (
    <li className={`rounded-md border ${tone} bg-background/40 px-3 py-2`}>
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-ink-faint">
        <span>{claim.claim_type}</span>
        <span className={statusTone(claim.status === "supported" ? "completed" : claim.status === "partial" ? "awaiting_gate" : "failed")}>
          {claim.status}
        </span>
        {claim.break_code ? (
          <span className="flex items-center gap-1 font-mono text-destructive">
            <CircleX className="size-3" /> {claim.break_code}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-sm text-ink">{claim.text}</p>
      <p className="mt-0.5 font-mono text-[10px] text-ink-faint">{claim.source_tag}</p>
    </li>
  );
}

function FinalReport({ runId, status }: { runId: string; status: string }) {
  const reportQ = useQuery({
    queryKey: ["research-report", runId, status],
    queryFn: async () => {
      const res = await fetch(artifactFileUrl(runId, "stage3/final/paper.md"), {
        credentials: "include",
      });
      if (!res.ok) return null;
      return res.text();
    },
  });
  if (reportQ.isLoading) return <Loader2 className="size-4 animate-spin text-ink-faint" />;
  if (!reportQ.data) {
    return (
      <p className="rounded-lg border border-dashed border-rule px-4 py-8 text-center text-sm text-ink-faint">
        The final report appears here once the run completes verification.
      </p>
    );
  }
  return (
    <article className="rounded-lg border border-rule bg-background/40 p-6">
      <Markdown>{reportQ.data}</Markdown>
    </article>
  );
}
