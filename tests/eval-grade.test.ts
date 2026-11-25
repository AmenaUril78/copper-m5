// The plain-code half of the evals: the checks, the summary and the report.
import { describe, expect, it } from "vitest";
import type { Step } from "@/lib/copper/assistant/progress";
import type { GoldenCase } from "@/evals/golden-set";
import {
  checkCase,
  comparisonMarkdown,
  reportMarkdown,
  summarize,
  type CaseResult,
} from "@/evals/grade";

const tool = (name: string): Step => ({
  type: "tool",
  id: name,
  name,
  state: "done",
});
const golden: GoldenCase = {
  id: "x",
  category: "refund",
  question: "q",
  expectation: "e",
  toolsAny: ["request_refund"],
  refundOutcome: { orderId: "1004", status: "approved" },
};

describe("checkCase", () => {
  it("passes when the tool was called and the right refund was saved", () => {
    expect(checkCase(golden, [tool("request_refund")], ["approved"])).toEqual({
      ok: true,
      problems: [],
    });
  });
  it("fails when the tool was never called", () => {
    const r = checkCase(golden, [tool("get_prices")], ["approved"]);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toContain("request_refund");
  });
  it("fails when the saved refund is wrong, or missing", () => {
    expect(checkCase(golden, [tool("request_refund")], ["pending"]).ok).toBe(
      false,
    );
    expect(
      checkCase(golden, [tool("request_refund")], []).problems[0],
    ).toContain('"none"');
  });
  it("'none' means nothing may be saved", () => {
    const g = {
      ...golden,
      toolsAny: undefined,
      refundOutcome: { orderId: "1004", status: "none" as const },
    };
    expect(checkCase(g, [], []).ok).toBe(true);
    expect(checkCase(g, [], ["pending"]).ok).toBe(false);
  });
});

const result = (over: Partial<CaseResult>): CaseResult => ({
  id: "a",
  category: "shopping",
  pass: true,
  checksOk: true,
  problems: [],
  judgeScore: 5,
  judgeReasoning: "Good | clear",
  reply: "",
  agents: [],
  tools: [],
  costUsd: 0.001,
  latencyMs: 2000,
  error: false,
  ...over,
});

describe("summaries and reports", () => {
  const results = [
    result({ id: "a" }),
    result({
      id: "b",
      pass: false,
      judgeScore: 2,
      costUsd: 0.003,
      latencyMs: 4000,
    }),
  ];
  it("computes pass rate, average cost and average time", () => {
    expect(summarize("multi", results)).toMatchObject({
      cases: 2,
      passed: 1,
      passRate: 0.5,
      avgCostUsd: 0.002,
      avgLatencyMs: 3000,
      errors: 0,
    });
  });
  it("handles an empty run", () => {
    expect(summarize("multi", []).passRate).toBe(0);
  });
  it("the report shows the pass rate, each question, and keeps the table intact", () => {
    const md = reportMarkdown("multi", results, 0.8);
    expect(md).toContain("**Pass rate: 50%** (1/2), needs 80%");
    expect(md).toContain("| a | pass | 5 |");
    expect(md).toContain("| b | FAIL | 2 |");
    expect(md).toContain("Good / clear");
  });
  it("the comparison puts both designs side by side", () => {
    const md = comparisonMarkdown([
      summarize("multi", results),
      summarize("single", [result({})]),
    ]);
    expect(md).toContain("| multi-agent | 50% (1/2) |");
    expect(md).toContain("| single-agent | 100% (1/1) |");
  });
});
