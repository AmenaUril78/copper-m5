// Observability: every support chat message becomes one "trace" in Langfuse.
// A trace is the full story of one message: which agent answered, each tool it
// used (with what it sent and got back), and the tokens, cost and time of its
// model calls. Langfuse is the only monitoring tool the app uses.
//
// Nothing here can break a chat. Without the Langfuse keys, or if Langfuse
// can't be reached, every function quietly does nothing.
//
// The keys are LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY; LANGFUSE_BASE_URL
// says which Langfuse region to use. They are read from the environment only.

export type TraceUsage = { inputTokens?: number; outputTokens?: number };

export type ChatTraceInfo = {
  /** What the customer asked. */
  input: string;
  /** "multi" (Copper plus the Refund agent) or "single" (one agent with every tool). */
  variant: "multi" | "single";
  /** Groups chats from one conversation (or one eval run) in Langfuse. */
  sessionId?: string;
  /** Extra labels, e.g. "eval". */
  tags?: string[];
};

export type RunTrace = {
  toolStart(id: string, name: string, input?: unknown): void;
  toolEnd(id: string, output: unknown, isError?: boolean): void;
  end(info: {
    usage?: TraceUsage;
    costUsd: number | null;
    output: string;
    ok: boolean;
  }): void;
};

export type ChatTrace = {
  /** The Langfuse trace id, or undefined when tracing is off. */
  traceId: string | undefined;
  /** One agent's turn inside this chat message. */
  startRun(info: { agent: string; model: string }): RunTrace;
  end(info: { output: string; ok: boolean }): void;
};

const NOOP_RUN: RunTrace = { toolStart() {}, toolEnd() {}, end() {} };
const NOOP_CHAT: ChatTrace = {
  traceId: undefined,
  startRun: () => NOOP_RUN,
  end() {},
};

/** True when both Langfuse keys are set. */
export function isTracingConfigured(): boolean {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY?.trim() &&
    process.env.LANGFUSE_SECRET_KEY?.trim(),
  );
}

type Processor = { forceFlush(): Promise<void> };
let processor: Promise<Processor | null> | undefined;

/** Starts Langfuse's span exporter once per server process. */
function ensureTracing(): Promise<Processor | null> {
  processor ??= (async () => {
    try {
      const [{ LangfuseSpanProcessor }, { NodeTracerProvider }, tracing] =
        await Promise.all([
          import("@langfuse/otel"),
          import("@opentelemetry/sdk-trace-node"),
          import("@langfuse/tracing"),
        ]);
      const spanProcessor = new LangfuseSpanProcessor({
        // Short waits: a serverless function can freeze right after it replies.
        exportMode: "immediate",
      });
      // A private provider, so it never fights with anything else that traces.
      tracing.setLangfuseTracerProvider(
        new NodeTracerProvider({ spanProcessors: [spanProcessor] }),
      );
      return spanProcessor;
    } catch (error) {
      console.error("[trace] Langfuse could not start:", messageOf(error));
      return null;
    }
  })();
  return processor;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs a tracing step, and never lets a tracing problem reach the chat. */
function safely<T>(step: () => T): T | undefined {
  try {
    return step();
  } catch (error) {
    console.error("[trace]", messageOf(error));
    return undefined;
  }
}

/** Starts the trace for one customer message. Call `end` when the reply is done. */
export async function startChatTrace(info: ChatTraceInfo): Promise<ChatTrace> {
  if (!isTracingConfigured()) return NOOP_CHAT;
  if (!(await ensureTracing())) return NOOP_CHAT;
  const { propagateAttributes, startObservation } =
    await import("@langfuse/tracing");

  const root = safely(() =>
    propagateAttributes(
      {
        traceName: "support-chat",
        sessionId: info.sessionId,
        tags: [`variant:${info.variant}`, ...(info.tags ?? [])],
        metadata: { variant: info.variant },
      },
      () =>
        startObservation(
          "support-chat",
          { input: info.input, metadata: { variant: info.variant } },
          { asType: "agent" },
        ),
    ),
  );
  if (!root) return NOOP_CHAT;

  return {
    traceId: root.traceId,
    startRun({ agent, model }) {
      const run = safely(() =>
        root.startObservation(agent, {}, { asType: "agent" }),
      );
      const generation = run
        ? safely(() =>
            run.startObservation("model", { model }, { asType: "generation" }),
          )
        : undefined;
      if (!run || !generation) return NOOP_RUN;

      type ToolObservation = {
        update(attributes: Record<string, unknown>): unknown;
        end(): void;
      };
      const tools = new Map<string, ToolObservation>();
      return {
        toolStart(id, name, input) {
          safely(() => {
            tools.set(
              id,
              run.startObservation(name, { input }, { asType: "tool" }),
            );
          });
        },
        toolEnd(id, output, isError) {
          safely(() => {
            const tool = tools.get(id);
            if (!tool) return;
            tool.update(
              isError
                ? { output, level: "ERROR", statusMessage: String(output) }
                : { output },
            );
            tool.end();
            tools.delete(id);
          });
        },
        end({ usage, costUsd, output, ok }) {
          safely(() => {
            for (const tool of tools.values()) tool.end();
            tools.clear();
            const input = usage?.inputTokens;
            const out = usage?.outputTokens;
            generation.update({
              output,
              level: ok ? "DEFAULT" : "ERROR",
              ...(input !== undefined && out !== undefined
                ? { usageDetails: { input, output: out, total: input + out } }
                : {}),
              ...(costUsd !== null ? { costDetails: { total: costUsd } } : {}),
            });
            generation.end();
            run.update({ output });
            run.end();
          });
        },
      };
    },
    end({ output, ok }) {
      safely(() => {
        root.update({
          output,
          level: ok ? "DEFAULT" : "ERROR",
        });
        root.end();
      });
    },
  };
}

type Scorer = {
  score: {
    create(data: {
      traceId: string;
      name: string;
      value: number;
      dataType: "NUMERIC" | "BOOLEAN";
      comment?: string;
    }): void;
    flush(): Promise<void>;
  };
};
let scorer: Promise<Scorer | null> | undefined;

function ensureScorer(): Promise<Scorer | null> {
  scorer ??= (async () => {
    if (!isTracingConfigured()) return null;
    try {
      const { LangfuseClient } = await import("@langfuse/client");
      return new LangfuseClient() as unknown as Scorer;
    } catch (error) {
      console.error(
        "[trace] Langfuse scores could not start:",
        messageOf(error),
      );
      return null;
    }
  })();
  return scorer;
}

/** Attaches a score (for example the AI judge's grade) to a trace in Langfuse. */
export async function scoreTrace(
  traceId: string | undefined,
  score: {
    name: string;
    value: number;
    dataType: "NUMERIC" | "BOOLEAN";
    comment?: string;
  },
): Promise<void> {
  if (!traceId) return;
  const client = await ensureScorer();
  if (!client) return;
  safely(() => client.score.create({ traceId, ...score }));
}

/** Sends everything waiting to Langfuse. Call before a serverless function ends. */
export async function flushTraces(): Promise<void> {
  const [spans, scores] = await Promise.all([
    processor ?? Promise.resolve(null),
    scorer ?? Promise.resolve(null),
  ]);
  try {
    await Promise.all([spans?.forceFlush(), scores?.score.flush()]);
  } catch (error) {
    console.error("[trace] flush failed:", messageOf(error));
  }
}
