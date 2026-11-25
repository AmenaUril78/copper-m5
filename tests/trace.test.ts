// Langfuse tracing: does nothing without keys, and records the agent, tools,
// tokens and cost when keys are set. Langfuse itself is faked here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Recorded = {
  name: string;
  attrs: Record<string, unknown>;
  type?: string;
  ended: boolean;
  updates: Record<string, unknown>[];
};
const recorded: Recorded[] = [];

function observation(
  name: string,
  attrs: Record<string, unknown>,
  type?: string,
) {
  const rec: Recorded = { name, attrs, type, ended: false, updates: [] };
  recorded.push(rec);
  return {
    traceId: "trace-123",
    update: (a: Record<string, unknown>) => void rec.updates.push(a),
    end: () => void (rec.ended = true),
    startObservation: (
      n: string,
      a: Record<string, unknown>,
      o?: { asType?: string },
    ) => observation(n, a, o?.asType),
  };
}

const propagated: Record<string, unknown>[] = [];
vi.mock("@langfuse/tracing", () => ({
  setLangfuseTracerProvider: vi.fn(),
  propagateAttributes: (params: Record<string, unknown>, fn: () => unknown) => {
    propagated.push(params);
    return fn();
  },
  startObservation: (
    n: string,
    a: Record<string, unknown>,
    o?: { asType?: string },
  ) => observation(n, a, o?.asType),
}));
vi.mock("@langfuse/otel", () => ({
  LangfuseSpanProcessor: class {
    forceFlush = vi.fn(async () => {});
  },
}));
vi.mock("@opentelemetry/sdk-trace-node", () => ({
  NodeTracerProvider: class {},
}));
const scoreCreate = vi.fn();
vi.mock("@langfuse/client", () => ({
  LangfuseClient: class {
    score = { create: scoreCreate, flush: vi.fn(async () => {}) };
  },
}));

beforeEach(() => {
  recorded.length = 0;
  propagated.length = 0;
  scoreCreate.mockClear();
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllEnvs());

const info = { input: "How much is Copper Home?", variant: "multi" as const };

describe("tracing is off without keys", () => {
  it("returns a quiet no-op trace and records nothing", async () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "");
    const { startChatTrace, isTracingConfigured, scoreTrace, flushTraces } =
      await import("@/lib/ai/trace");
    expect(isTracingConfigured()).toBe(false);
    const chat = await startChatTrace(info);
    expect(chat.traceId).toBeUndefined();
    const run = chat.startRun({
      agent: "copper",
      model: "google/gemini-3-flash",
    });
    run.toolStart("1", "get_prices", {});
    run.toolEnd("1", {});
    run.end({ costUsd: 0.1, output: "x", ok: true });
    chat.end({ output: "x", ok: true });
    await scoreTrace("t", { name: "a", value: 1, dataType: "BOOLEAN" });
    await flushTraces();
    expect(recorded).toHaveLength(0);
    expect(scoreCreate).not.toHaveBeenCalled();
  });

  it("needs both keys", async () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-test");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "");
    const { isTracingConfigured } = await import("@/lib/ai/trace");
    expect(isTracingConfigured()).toBe(false);
  });
});

describe("tracing is on with keys", () => {
  beforeEach(() => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-test");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-test");
  });

  it("records the chat, the agent, its tools, tokens and cost", async () => {
    const { startChatTrace } = await import("@/lib/ai/trace");
    const chat = await startChatTrace({
      ...info,
      sessionId: "s1",
      tags: ["eval"],
    });
    expect(chat.traceId).toBe("trace-123");
    expect(propagated[0]).toMatchObject({
      traceName: "support-chat",
      sessionId: "s1",
      tags: ["variant:multi", "eval"],
    });

    const run = chat.startRun({
      agent: "refund-agent",
      model: "google/gemini-3-flash",
    });
    run.toolStart("c1", "request_refund", { orderId: "1004" });
    run.toolEnd("c1", { status: "approved" });
    run.end({
      usage: { inputTokens: 100, outputTokens: 20 },
      costUsd: 0.0001,
      output: "Approved.",
      ok: true,
    });
    chat.end({ output: "Approved.", ok: true });

    const byName = (n: string) => recorded.find((r) => r.name === n)!;
    expect(byName("support-chat")).toMatchObject({
      type: "agent",
      ended: true,
    });
    expect(byName("refund-agent")).toMatchObject({
      type: "agent",
      ended: true,
    });
    expect(byName("request_refund")).toMatchObject({
      type: "tool",
      ended: true,
    });
    expect(byName("request_refund").attrs.input).toEqual({ orderId: "1004" });
    expect(byName("request_refund").updates[0]).toEqual({
      output: { status: "approved" },
    });
    const generation = byName("model");
    expect(generation.type).toBe("generation");
    expect(generation.attrs.model).toBe("google/gemini-3-flash");
    expect(generation.updates[0]).toMatchObject({
      usageDetails: { input: 100, output: 20, total: 120 },
      costDetails: { total: 0.0001 },
    });
  });

  it("marks a failed tool and ends tools left open", async () => {
    const { startChatTrace } = await import("@/lib/ai/trace");
    const chat = await startChatTrace(info);
    const run = chat.startRun({ agent: "copper", model: "m" });
    run.toolStart("a", "get_prices", {});
    run.toolEnd("a", "boom", true);
    run.toolStart("b", "check_availability", {});
    run.end({ costUsd: null, output: "", ok: false });
    expect(
      recorded.find((r) => r.name === "get_prices")!.updates[0],
    ).toMatchObject({ level: "ERROR" });
    expect(recorded.find((r) => r.name === "check_availability")!.ended).toBe(
      true,
    );
  });

  it("sends scores to Langfuse against the trace", async () => {
    const { scoreTrace } = await import("@/lib/ai/trace");
    await scoreTrace("trace-123", {
      name: "judge_pass",
      value: 1,
      dataType: "BOOLEAN",
      comment: "ok",
    });
    expect(scoreCreate).toHaveBeenCalledWith({
      traceId: "trace-123",
      name: "judge_pass",
      value: 1,
      dataType: "BOOLEAN",
      comment: "ok",
    });
  });
});
