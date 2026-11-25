// The AI judge, with its model call faked: what it is told, and how the pass
// line is decided (in code, from the 1-5 score).
import { beforeEach, describe, expect, it, vi } from "vitest";

const callObject = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai/call", () => ({ callObject }));

import { GOLDEN_SET } from "@/evals/golden-set";
import {
  describeTools,
  judgeAnswer,
  judgePrompt,
  PASS_SCORE,
} from "@/evals/judge";
import type { Step } from "@/lib/copper/assistant/progress";

const golden = GOLDEN_SET.find((c) => c.id === "refund-over-limit")!;
const steps: Step[] = [
  {
    type: "tool",
    id: "1",
    name: "request_refund",
    state: "done",
    input: { orderId: "1003" },
    output: { status: "pending" },
  },
];

beforeEach(() => callObject.mockReset());

describe("judge", () => {
  it("shows the judge the question, the expectation, the tool results and the reply", () => {
    const prompt = judgePrompt(golden, "It is with a specialist.", steps);
    expect(prompt).toContain(golden.question);
    expect(prompt).toContain(golden.expectation);
    expect(prompt).toContain(
      'request_refund({"orderId":"1003"}) -> {"status":"pending"}',
    );
    expect(prompt).toContain("It is with a specialist.");
  });

  it("says plainly when no tools were used", () => {
    expect(describeTools([])).toBe("(no tools were used)");
  });

  it("passes at the pass score and fails below it", async () => {
    callObject.mockResolvedValueOnce({
      output: { score: PASS_SCORE, reasoning: "ok" },
    });
    expect((await judgeAnswer(golden, "r", steps)).pass).toBe(true);
    callObject.mockResolvedValueOnce({
      output: { score: PASS_SCORE - 1, reasoning: "no" },
    });
    expect((await judgeAnswer(golden, "r", steps)).pass).toBe(false);
  });

  it("goes through the logged AI wrapper as module 5, feature eval-judge", async () => {
    callObject.mockResolvedValueOnce({ output: { score: 5, reasoning: "ok" } });
    await judgeAnswer(golden, "r", steps);
    expect(callObject.mock.calls[0][0]).toEqual({
      module: 5,
      feature: "eval-judge",
    });
    expect(callObject.mock.calls[0][1].temperature).toBe(0);
  });
});
