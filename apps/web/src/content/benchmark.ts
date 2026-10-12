// Frozen common-case results from docs/bioprobench-no-rag-comparison.json.
// Each row excludes refusals in ANY of the three arms; model calls cover all 200 cases.
export const benchmarkRows = [
  {
    metric: "QA accuracy",
    detail: "Question answering",
    n: "46",
    noRag: "73.91%",
    rag: "80.43%",
    agent: "80.43%",
  },
  {
    metric: "ORD accuracy",
    detail: "Step ordering",
    n: "42",
    noRag: "50.00%",
    rag: "57.14%",
    agent: "61.90%",
  },
  {
    metric: "ERR accuracy",
    detail: "Error detection",
    n: "43",
    noRag: "67.44%",
    rag: "74.42%",
    agent: "74.42%",
  },
  {
    metric: "GEN token F1",
    detail: "Protocol generation",
    n: "36",
    noRag: "0.1970",
    rag: "0.2741",
    agent: "0.2908",
  },
  {
    metric: "Total model calls",
    detail: "All 200 selected cases",
    n: "—",
    noRag: "200",
    rag: "200",
    agent: "418",
  },
] as const;
