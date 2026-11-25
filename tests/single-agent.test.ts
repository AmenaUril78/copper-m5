// The single-agent design: one agent with every tool and no hand-off, chosen by
// the server's SUPPORT_AGENT_MODE setting. Tested with a fake model, so no key
// and no cost.
import type { LanguageModelV4StreamPart as ModelStreamPart } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalValue } from "@/lib/ai/live";

vi.mock("@/lib/copper/refunds", () => ({
  readOrder: vi.fn(),
  readRefund: vi.fn(),
  readLatestRefundForOrder: vi.fn(),
  readLimitCents: vi.fn(),
  readOpenRefundForOrder: vi.fn(),
  createRefund: vi.fn(),
  markOrderRefunded: vi.fn(),
}));

let model: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => model,
}));

const usage = {
  inputTokens: {
    total: 100,
    noCache: 100,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};
type StreamPart = Parameters<
  typeof convertArrayToReadableStream<ModelStreamPart>
>[0][number];
const says = (text: string): StreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
];
function modelStreaming(...steps: StreamPart[][]) {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream(steps[step++] ?? says("")),
    }),
  });
}
const toolNames = (call: number) =>
  (model.doStreamCalls[call].tools ?? []).map((t) => t.name).sort();

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function load(mode?: string) {
  vi.resetModules();
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
  if (mode) vi.stubEnv("SUPPORT_AGENT_MODE", mode);
  return import("@/lib/copper/assistant/support");
}

describe("single-agent mode", () => {
  it("gives one agent all seven tools and no hand-off", async () => {
    model = modelStreaming(says("Copper Home is $149."));
    const { askSupport } = await load("single");
    const result = await finalValue(
      (
        await askSupport({
          messages: [{ role: "user", content: "How much is Copper Home?" }],
          mode: "shopping",
        })
      ).progress,
    );
    expect(result).toMatchObject({ mode: "shopping", status: "done" });
    expect(toolNames(0)).toEqual([
      "calculate_cost",
      "check_availability",
      "check_refund_status",
      "get_prices",
      "get_products",
      "lookup_order",
      "request_refund",
    ]);
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("a refund request stays with the same agent: no second agent is started", async () => {
    model = modelStreaming(says("What is your order number?"));
    const { askSupport } = await load("single");
    const result = await finalValue(
      (
        await askSupport({
          messages: [{ role: "user", content: "I want my money back" }],
          mode: "shopping",
        })
      ).progress,
    );
    expect(result.mode).toBe("shopping");
    expect(result.reply).toBe("What is your order number?");
    expect(model.doStreamCalls).toHaveLength(1);
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain(
      "refund specialist",
    );
  });

  it("the default (and any other value) is the two-agent design", async () => {
    model = modelStreaming(says("Copper Home is $149."));
    const { askSupport } = await load("something-else");
    await finalValue(
      (
        await askSupport({
          messages: [{ role: "user", content: "How much is Copper Home?" }],
          mode: "shopping",
        })
      ).progress,
    );
    expect(toolNames(0)).toContain("hand_off_to_refund_agent");
  });

  it("a visitor can't choose the design in the request", async () => {
    model = modelStreaming(says("ok"));
    const { askSupport } = await load();
    await expect(
      askSupport({
        messages: [{ role: "user", content: "hi" }],
        mode: "shopping",
        variant: "single",
      } as never),
    ).rejects.toThrow();
  });
});
