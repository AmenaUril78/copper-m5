// The plain-code half of grading, and the report. No AI in this file.
import type { Step } from "@/lib/copper/assistant/progress";
import type { GoldenCase, RefundOutcome } from "@/evals/golden-set";

/** What the code checks, before the AI judge reads a word. */
export function checkCase(
  golden: GoldenCase,
  steps: Step[],
  savedStatuses: RefundOutcome[],
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const used = new Set(
    steps.filter((s) => s.type === "tool").map((s) => s.name),
  );

  if (golden.toolsAny && !golden.toolsAny.some((t) => used.has(t))) {
    problems.push(`none of ${golden.toolsAny.join(" / ")} was called`);
  }
  if (golden.refundOutcome) {
    const want = golden.refundOutcome.status;
    const got = savedStatuses.length ? savedStatuses.at(-1)! : "none";
    if (got !== want)
      problems.push(`saved refund was "${got}", wanted "${want}"`);
  }
  return { ok: problems.length === 0, problems };
}

export type CaseResult = {
  id: string;
  category: string;
  pass: boolean;
  checksOk: boolean;
  problems: string[];
  judgeScore: number | null;
  judgeReasoning: string;
  reply: string;
  agents: string[];
  tools: string[];
  costUsd: number;
  latencyMs: number;
  /** The question could not be answered (for example the AI quota ran out). */
  error: boolean;
  traceId?: string;
};

export type VariantSummary = {
  variant: string;
  cases: number;
  passed: number;
  passRate: number;
  avgCostUsd: number;
  totalCostUsd: number;
  avgLatencyMs: number;
  errors: number;
};

export function summarize(
  variant: string,
  results: CaseResult[],
): VariantSummary {
  const n = results.length;
  const passed = results.filter((r) => r.pass).length;
  const total = results.reduce((sum, r) => sum + r.costUsd, 0);
  const latency = results.reduce((sum, r) => sum + r.latencyMs, 0);
  return {
    variant,
    cases: n,
    passed,
    passRate: n === 0 ? 0 : passed / n,
    avgCostUsd: n === 0 ? 0 : total / n,
    totalCostUsd: total,
    avgLatencyMs: n === 0 ? 0 : Math.round(latency / n),
    errors: results.filter((r) => r.error).length,
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const usd = (x: number) => `$${x.toFixed(5)}`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** The score table shown in the pull request's check (and the job summary). */
export function reportMarkdown(
  variant: string,
  results: CaseResult[],
  minPassRate: number,
): string {
  const s = summarize(variant, results);
  const lines = [
    `## Ask Copper evals: ${variant}-agent`,
    "",
    `**Pass rate: ${pct(s.passRate)}** (${s.passed}/${s.cases}), needs ${pct(minPassRate)} · average cost ${usd(s.avgCostUsd)} per question · average time ${seconds(s.avgLatencyMs)}${s.errors ? ` · ${s.errors} could not be answered` : ""}`,
    "",
    "| Question | Result | Judge (1-5) | Code checks | Why |",
    "|---|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.id} | ${r.pass ? "pass" : "FAIL"} | ${r.judgeScore ?? "-"} | ${r.checksOk ? "ok" : r.problems.join("; ")} | ${r.judgeReasoning.replace(/\|/g, "/").replace(/\n/g, " ")} |`,
    ),
  ];
  return lines.join("\n");
}

/** Side by side: the numbers for Part 4 of the assignment. */
export function comparisonMarkdown(summaries: VariantSummary[]): string {
  return [
    "## Single agent vs multi agent",
    "",
    "| | Pass rate | Average cost per question | Average time per question |",
    "|---|---|---|---|",
    ...summaries.map(
      (s) =>
        `| ${s.variant}-agent | ${pct(s.passRate)} (${s.passed}/${s.cases}) | ${usd(s.avgCostUsd)} | ${seconds(s.avgLatencyMs)} |`,
    ),
  ].join("\n");
}
