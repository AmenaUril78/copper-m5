// @vitest-environment node
// Runs the golden set against the real model, has the AI judge grade each
// answer, and sends the scores to Langfuse. Run it with `npm run eval`.
//
//   EVAL_VARIANTS   multi (default), single, or both
//   EVAL_CASES      comma-separated question ids to run (default: all)
//   EVAL_MIN_PASS_RATE  the pass rate needed to succeed (default 0.8)
//   EVAL_PAUSE_MS   wait between calls, for a free key's per-minute limit
//
// Refunds use an in-memory copy of the demo orders (evals/fake-refund-store.ts),
// so this can never touch the real database.
import { existsSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

vi.mock(
  "@/lib/copper/refunds",
  async () => import("@/evals/fake-refund-store"),
);

import { finalValue } from "@/lib/ai/live";
import { flushTraces, isTracingConfigured, scoreTrace } from "@/lib/ai/trace";
import {
  runSupport,
  type SupportMetrics,
  type SupportVariant,
} from "@/lib/copper/assistant/support-core";
import { refundsForOrder, resetStore } from "@/evals/fake-refund-store";
import { GOLDEN_SET, type RefundOutcome } from "@/evals/golden-set";
import {
  checkCase,
  comparisonMarkdown,
  reportMarkdown,
  summarize,
  type CaseResult,
  type VariantSummary,
} from "@/evals/grade";
import { judgeAnswer } from "@/evals/judge";

const MIN_PASS_RATE = Number(process.env.EVAL_MIN_PASS_RATE ?? "0.8");
const wanted = process.env.EVAL_VARIANTS ?? "multi";
const variants: SupportVariant[] =
  wanted === "both"
    ? ["multi", "single"]
    : wanted === "single"
      ? ["single"]
      : ["multi"];
const onlyCases = process.env.EVAL_CASES?.split(",").map((s) => s.trim());
const cases = GOLDEN_SET.filter((c) => !onlyCases || onlyCases.includes(c.id));

// Optional wait (in milliseconds) before each grading call and after each
// question, to stay under a free API key's requests-per-minute limit.
const PAUSE_MS = Number(process.env.EVAL_PAUSE_MS ?? "0");
const pause = () =>
  PAUSE_MS > 0
    ? new Promise<void>((r) => setTimeout(r, PAUSE_MS))
    : Promise.resolve();

const summaries: VariantSummary[] = [];

function publish(markdown: string) {
  mkdirSync("eval-results", { recursive: true });
  appendFileSync("eval-results/report.md", `${markdown}\n\n`);
  // In GitHub Actions this appears on the pull request's check page.
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n\n`);
  }
  console.info(markdown);
}

describe("Ask Copper golden set", () => {
  it("has a model key", () => {
    expect(
      process.env.GOOGLE_GENERATIVE_AI_API_KEY,
      "Set GOOGLE_GENERATIVE_AI_API_KEY (in .env.local, or as a GitHub Actions secret).",
    ).toBeTruthy();
  });

  for (const variant of variants) {
    it(
      `${variant}-agent passes the golden set`,
      async () => {
        const runId = `eval-${variant}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        const results: CaseResult[] = [];

        for (const golden of cases) {
          resetStore();
          let metrics: SupportMetrics | undefined;
          const { progress } = await runSupport(
            {
              messages: [{ role: "user", content: golden.question }],
              mode: "shopping",
            },
            {
              variant,
              sessionId: runId,
              tags: ["eval", `case:${golden.id}`],
              onMetrics: (m) => (metrics = m),
            },
          );
          const final = await finalValue(progress);
          const failed = final.status === "error";

          const saved: RefundOutcome[] = golden.refundOutcome
            ? refundsForOrder(golden.refundOutcome.orderId).map((r) => r.status)
            : [];
          const checks = checkCase(golden, final.steps, saved);

          let judgeScore: number | null = null;
          let judgeReasoning = failed ? "The chat could not answer." : "";
          let judgePass = false;
          let judgeFailed = false;
          if (!failed) {
            // Stay under the free tier's requests-per-minute limit.
            await pause();
            try {
              const verdict = await judgeAnswer(
                golden,
                final.reply,
                final.steps,
              );
              judgeScore = verdict.score;
              judgeReasoning = verdict.reasoning;
              judgePass = verdict.pass;
            } catch (error) {
              // One failed grading call counts as a failed question; it
              // must not throw away the other questions' results.
              judgeFailed = true;
              judgeReasoning = `The judge could not grade this answer: ${error instanceof Error ? error.message.slice(0, 120) : "unknown error"}`;
            }
          }

          // onMetrics is called after the last update, so give it a moment.
          for (let i = 0; i < 50 && !metrics; i++) {
            await new Promise((r) => setTimeout(r, 100));
          }
          const pass = !failed && checks.ok && judgePass;
          const result: CaseResult = {
            id: golden.id,
            category: golden.category,
            pass,
            checksOk: checks.ok,
            problems: checks.problems,
            judgeScore,
            judgeReasoning,
            reply: final.reply,
            agents: metrics?.agents ?? [],
            tools: metrics?.tools ?? [],
            costUsd: metrics?.costUsd ?? 0,
            latencyMs: metrics?.latencyMs ?? 0,
            error: failed || judgeFailed,
            traceId: metrics?.traceId,
          };
          results.push(result);

          // The scores sit on the same trace as the chat, so Langfuse shows
          // the answer, the tools and the grade together.
          if (!failed) {
            await scoreTrace(result.traceId, {
              name: "judge_score",
              value: (judgeScore ?? 0) / 5,
              dataType: "NUMERIC",
              comment: judgeReasoning,
            });
            await scoreTrace(result.traceId, {
              name: "judge_pass",
              value: judgePass ? 1 : 0,
              dataType: "BOOLEAN",
              comment: judgeReasoning,
            });
          }
          await scoreTrace(result.traceId, {
            name: "case_pass",
            value: pass ? 1 : 0,
            dataType: "BOOLEAN",
            comment: checks.problems.join("; ") || undefined,
          });
          await pause();
        }

        const summary = summarize(variant, results);
        summaries.push(summary);
        mkdirSync("eval-results", { recursive: true });
        writeFileSync(
          `eval-results/${variant}.json`,
          JSON.stringify({ summary, results }, null, 2),
        );
        publish(reportMarkdown(variant, results, MIN_PASS_RATE));
        if (process.env.GITHUB_ACTIONS) {
          console.info(
            `::notice title=Eval score (${variant}-agent)::Pass rate ${Math.round(summary.passRate * 100)}% (${summary.passed}/${summary.cases}), average cost $${summary.avgCostUsd.toFixed(5)}, average time ${(summary.avgLatencyMs / 1000).toFixed(1)}s`,
          );
        }
        if (summaries.length > 1) publish(comparisonMarkdown(summaries));
        if (isTracingConfigured()) await flushTraces();

        expect(
          summary.passRate,
          `${variant}-agent pass rate ${Math.round(summary.passRate * 100)}% is below ${Math.round(MIN_PASS_RATE * 100)}%`,
        ).toBeGreaterThanOrEqual(MIN_PASS_RATE);
      },
      30 * 60 * 1000,
    );
  }
});
