"use client";

interface Props {
  sources: string[];
  selected: string | null;
  onChange: (v: string | null) => void;
}

export default function SourceFilter({ sources, selected, onChange }: Props) {
  const chip = (label: string, value: string | null, active: boolean) => (
    <button
      key={label}
      type="button"
      onClick={() => onChange(value)}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
        active
          ? "border-ink bg-ink text-paper"
          : "border-rule bg-paper text-muted hover:border-ink hover:text-ink"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      {chip("All", null, selected === null)}
      {sources.map((s) => chip(s, s, selected === s))}
    </div>
  );
}
