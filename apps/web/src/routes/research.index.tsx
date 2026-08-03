import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { FlaskConical, Loader2, Plus, Trash2 } from "lucide-react";

import { ApiError } from "~/lib/api";
import { createRun, listRuns, stageLabel, statusTone, type RunSummary } from "~/lib/research";
import { useCurrentUser } from "~/lib/auth";
import { Button } from "~/components/ui/button";

export const Route = createFileRoute("/research/")({
  component: ResearchPage,
});

interface SeedInput {
  refId: string;
}

function ResearchPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: user, isLoading: authLoading } = useCurrentUser();
  useEffect(() => {
    if (!authLoading && !user) navigate({ to: "/login", search: { next: "/research" } });
  }, [authLoading, user, navigate]);

  const runsQ = useQuery({
    queryKey: ["research-runs"],
    queryFn: listRuns,
    enabled: !!user,
    refetchInterval: 10_000,
  });

  const [showLauncher, setShowLauncher] = useState(false);
  const [question, setQuestion] = useState("");
  const [title, setTitle] = useState("");
  const [seeds, setSeeds] = useState<SeedInput[]>([{ refId: "" }]);
  const [evaluatorCommand, setEvaluatorCommand] = useState("");
  const [branches, setBranches] = useState(3);
  const [iterations, setIterations] = useState(3);
  const [keepK, setKeepK] = useState(2);
  const [maxCostUsd, setMaxCostUsd] = useState("");
  const [approveAfterBrief, setApproveAfterBrief] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      createRun({
        title: title.trim() || undefined,
        question: question.trim(),
        seeds: seeds.filter((s) => s.refId.trim()).map((s) => ({ refId: s.refId.trim() })),
        evaluator: evaluatorCommand.trim()
          ? { kind: "command", command: evaluatorCommand.trim() }
          : { kind: "none" },
        budget: {
          branches,
          iterations,
          keepK,
          ...(maxCostUsd.trim() && Number(maxCostUsd) > 0 ? { maxCostUsd: Number(maxCostUsd) } : {}),
        },
        gates: { approveAfterBrief },
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["research-runs"] });
      void navigate({ to: "/research/$runId", params: { runId: r.run.id } });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Failed to start the run."),
  });

  const runs = runsQ.data?.runs ?? [];

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-8">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <FlaskConical className="size-6 text-ink-light" />
          <div>
            <h1 className="text-xl font-semibold text-ink">Research runs</h1>
            <p className="text-sm text-ink-light">
              Autonomous multi-agent pipeline: literature grounding → explore/exploit discovery →
              claim-verified report (chain-of-evidence).
            </p>
          </div>
        </div>
        <Button onClick={() => setShowLauncher((v) => !v)} className="gap-2">
          <Plus className="size-4" />
          New run
        </Button>
      </header>

      {showLauncher ? (
        <section className="flex flex-col gap-4 rounded-lg border border-rule bg-background/40 p-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-ink">Research question / task</span>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={3}
              placeholder="What should the pipeline investigate, build, and report on?"
              className="rounded-md border border-rule bg-background px-3 py-2 text-sm text-ink"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-ink">Title (optional)</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="rounded-md border border-rule bg-background px-3 py-2 text-sm text-ink"
            />
          </label>

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-ink">
              Seed references (1–4; doi:… / pmid:… / pmcid:… / openalex:W…)
            </span>
            {seeds.map((seed, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  value={seed.refId}
                  onChange={(e) =>
                    setSeeds((prev) => prev.map((s, j) => (j === i ? { refId: e.target.value } : s)))
                  }
                  placeholder="doi:10.1038/s41586-…"
                  className="flex-1 rounded-md border border-rule bg-background px-3 py-2 font-mono text-xs text-ink"
                />
                {seeds.length > 1 ? (
                  <button
                    type="button"
                    aria-label="Remove seed"
                    onClick={() => setSeeds((prev) => prev.filter((_, j) => j !== i))}
                    className="rounded p-1 text-ink-faint hover:text-destructive"
                  >
                    <Trash2 className="size-4" />
                  </button>
                ) : null}
              </div>
            ))}
            {seeds.length < 4 ? (
              <button
                type="button"
                onClick={() => setSeeds((prev) => [...prev, { refId: "" }])}
                className="self-start text-xs text-ink-light hover:text-ink"
              >
                + add seed
              </button>
            ) : null}
          </div>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-ink">Golden evaluator command (optional)</span>
            <input
              value={evaluatorCommand}
              onChange={(e) => setEvaluatorCommand(e.target.value)}
              placeholder='e.g. python evaluate.py — last stdout line must be {"score": <number>}'
              className="rounded-md border border-rule bg-background px-3 py-2 font-mono text-xs text-ink"
            />
            <span className="text-xs text-ink-faint">
              Without one, discovery is pruned by an LLM rubric and the final report labels all
              quantitative outcomes as unverified.
            </span>
          </label>

          <div className="flex flex-wrap items-end gap-4">
            <NumberField label="Branches (B)" value={branches} onChange={setBranches} min={1} max={8} />
            <NumberField label="Iterations (I)" value={iterations} onChange={setIterations} min={1} max={8} />
            <NumberField label="Keep top-K" value={keepK} onChange={setKeepK} min={1} max={8} />
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-ink">Cost cap (USD, optional)</span>
              <input
                value={maxCostUsd}
                onChange={(e) => setMaxCostUsd(e.target.value)}
                placeholder="e.g. 25"
                className="w-32 rounded-md border border-rule bg-background px-3 py-2 text-sm text-ink"
              />
            </label>
            <label className="flex items-center gap-2 pb-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={approveAfterBrief}
                onChange={(e) => setApproveAfterBrief(e.target.checked)}
              />
              Pause for my approval after the Experiment Brief
            </label>
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="flex gap-2">
            <Button
              disabled={create.isPending || question.trim().length < 12 || !seeds.some((s) => s.refId.trim())}
              onClick={() => {
                setError(null);
                create.mutate();
              }}
              className="gap-2"
            >
              {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <FlaskConical className="size-4" />}
              Launch run
            </Button>
            <Button variant="ghost" onClick={() => setShowLauncher(false)}>
              Cancel
            </Button>
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        {runsQ.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-ink-light">
            <Loader2 className="size-4 animate-spin" /> Loading runs…
          </p>
        ) : runs.length === 0 ? (
          <p className="rounded-lg border border-dashed border-rule px-4 py-8 text-center text-sm text-ink-faint">
            No research runs yet. Launch one with a question and 1–4 seed papers.
          </p>
        ) : (
          runs.map((run) => <RunCard key={run.id} run={run} />)
        )}
      </section>
    </div>
  );
}

function NumberField(props: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-ink">{props.label}</span>
      <input
        type="number"
        value={props.value}
        min={props.min}
        max={props.max}
        onChange={(e) =>
          props.onChange(Math.max(props.min, Math.min(props.max, Number(e.target.value) || props.min)))
        }
        className="w-24 rounded-md border border-rule bg-background px-3 py-2 text-sm text-ink"
      />
    </label>
  );
}

function RunCard({ run }: { run: RunSummary }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => void navigate({ to: "/research/$runId", params: { runId: run.id } })}
      className="flex items-center justify-between gap-4 rounded-lg border border-rule bg-background/40 px-4 py-3 text-left transition hover:border-ink-faint"
    >
      <div className="min-w-0">
        <p className="truncate font-medium text-ink">{run.title}</p>
        <p className="truncate text-xs text-ink-faint">{run.question}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3 text-xs">
        {run.pendingGates.length > 0 ? (
          <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-amber-600">
            needs approval
          </span>
        ) : null}
        {run.stage ? <span className="text-ink-light">{stageLabel(run.stage)}</span> : null}
        <span className={statusTone(run.status)}>{run.status}</span>
        <span className="tabular-nums text-ink-faint">${run.costUsd.toFixed(2)}</span>
      </div>
    </button>
  );
}
