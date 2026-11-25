// The switchboard's working parts. support.ts (the public Server Action) and
// the evals both call runSupport; the two designs differ only in `variant`:
//   multi:  Copper, plus a hand-off to the Refund agent (Module 4)
//   single: one agent with every tool and no hand-off (Module 5, for comparing)
// Every message is traced in Langfuse (see lib/ai/trace.ts).
import { stepCountIs } from "ai";
import { callStream, THOUGHT_SUMMARIES } from "@/lib/ai/call";
import { createLive, type Live } from "@/lib/ai/live";
import { defaultModel } from "@/lib/ai/models";
import { costUsd } from "@/lib/ai/pricing";
import { flushTraces, startChatTrace } from "@/lib/ai/trace";
import {
  looksLikeRefundRequest,
  SUPPORT_INSTRUCTIONS,
  supportTools,
} from "@/lib/copper/assistant/handoff";
import type { Progress, Step } from "@/lib/copper/assistant/progress";
import {
  CORRECTION,
  isUnbackedClaim,
  receiptFor,
  UNBACKED_FALLBACK,
} from "@/lib/copper/assistant/reply-check";
import {
  REFUND_INSTRUCTIONS,
  refundTools,
} from "@/lib/copper/assistant/refund-agent";
import {
  SINGLE_AGENT_INSTRUCTIONS,
  singleAgentTools,
} from "@/lib/copper/assistant/single-agent";

export type SupportMode = "shopping" | "refund";
export type SupportMessage = { role: "user" | "assistant"; content: string };
export type SupportRequest = { messages: SupportMessage[]; mode: SupportMode };
export type SupportVariant = "multi" | "single";

/** What the chat draws, plus which agent now has the chat. */
export type SupportProgress = Progress & { mode: SupportMode };
export type SupportResult = { progress: Live<SupportProgress> };

/** What one message cost, for the evals' comparison. */
export type SupportMetrics = {
  traceId: string | undefined;
  agents: string[];
  tools: string[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
};

export type RunSupportOptions = {
  variant?: SupportVariant;
  /** Groups this chat with others in Langfuse. */
  sessionId?: string;
  /** Extra Langfuse labels, e.g. "eval". */
  tags?: string[];
  /** Called once, when the message is finished. */
  onMetrics?: (metrics: SupportMetrics) => void;
};

type AgentKey = SupportMode | "single";

const MAX_STEPS = 5;
/**
 * At most three agent runs per message: a hand-off (or hand-back) and the
 * agent it hands to, plus one retry if an agent claims an outcome
 * that no tool result backs up.
 */
const MAX_RUNS = 3;

const APOLOGY = "Sorry, I couldn't answer that just now. Please try again.";

const TRACE_NAMES: Record<AgentKey, string> = {
  shopping: "copper",
  refund: "refund-agent",
  single: "single-agent",
};

function snapshot(progress: SupportProgress): SupportProgress {
  return {
    ...progress,
    steps: progress.steps.map((step): Step => ({ ...step })),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Starts the agent that owns this turn. A correction is added to its instructions on a retry. */
function runAgent(
  agent: AgentKey,
  messages: SupportMessage[],
  correction?: string,
) {
  const withCorrection = (text: string) =>
    correction ? `${text}\n\n${correction}` : text;
  const base = { messages, providerOptions: THOUGHT_SUMMARIES };
  switch (agent) {
    case "refund":
      return callStream(
        { module: 4, feature: "refund-agent" },
        {
          ...base,
          stopWhen: stepCountIs(MAX_STEPS),
          instructions: withCorrection(REFUND_INSTRUCTIONS),
          tools: refundTools,
        },
      );
    case "single":
      return callStream(
        { module: 5, feature: "single-agent" },
        {
          ...base,
          stopWhen: stepCountIs(MAX_STEPS),
          instructions: withCorrection(SINGLE_AGENT_INSTRUCTIONS),
          tools: singleAgentTools,
        },
      );
    default:
      return callStream(
        { module: 4, feature: "ask-copper-support" },
        {
          ...base,
          stopWhen: stepCountIs(MAX_STEPS),
          instructions: SUPPORT_INSTRUCTIONS,
          tools: supportTools,
        },
      );
  }
}

export async function runSupport(
  request: SupportRequest,
  options: RunSupportOptions = {},
): Promise<SupportResult> {
  const { messages, mode: startMode } = request;
  const variant = options.variant ?? "multi";
  const { live, update, done } = createLive<SupportProgress>();

  void (async () => {
    const started = performance.now();
    const progress: SupportProgress = {
      steps: [],
      reply: "",
      status: "working",
      mode: startMode,
    };
    const toolStep = (id: string) =>
      progress.steps.find((s) => s.type === "tool" && s.id === id);
    const lastQuestion = messages.filter((m) => m.role === "user").at(-1);

    const metrics: SupportMetrics = {
      traceId: undefined,
      agents: [],
      tools: [],
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      latencyMs: 0,
    };
    const chat = await startChatTrace({
      input: lastQuestion?.content ?? "",
      variant,
      sessionId: options.sessionId,
      tags: options.tags,
    });
    metrics.traceId = chat.traceId;

    // Set once an agent has been caught claiming an outcome nothing backs up,
    // so it is retried only once.
    let correction: string | undefined;
    let ok = true;

    try {
      for (let run = 0; run < MAX_RUNS; run++) {
        const agent: AgentKey = variant === "single" ? "single" : progress.mode;
        const model = defaultModel();
        const trace = chat.startRun({ agent: TRACE_NAMES[agent], model });
        metrics.agents.push(TRACE_NAMES[agent]);
        const result = runAgent(agent, messages, correction);
        let handedOff = false;
        let handedBack = false;
        let thisReply = "";
        // A second agent's words start a new paragraph.
        if (progress.reply.trim()) progress.reply += "\n\n";

        try {
          for await (const part of result.fullStream) {
            switch (part.type) {
              case "reasoning-delta": {
                const last = progress.steps.at(-1);
                if (last?.type === "thinking") last.text += part.text;
                else progress.steps.push({ type: "thinking", text: part.text });
                break;
              }
              case "tool-input-start":
                progress.steps.push({
                  type: "tool",
                  id: part.id,
                  name: part.toolName,
                  state: "calling",
                });
                break;
              case "tool-call": {
                const step = toolStep(part.toolCallId);
                if (step?.type === "tool") step.input = part.input;
                else
                  progress.steps.push({
                    type: "tool",
                    id: part.toolCallId,
                    name: part.toolName,
                    state: "calling",
                    input: part.input,
                  });
                metrics.tools.push(part.toolName);
                trace.toolStart(part.toolCallId, part.toolName, part.input);
                break;
              }
              case "tool-result": {
                const step = toolStep(part.toolCallId);
                if (step?.type === "tool") {
                  step.output = part.output;
                  step.state = "done";
                }
                trace.toolEnd(part.toolCallId, part.output);
                if (part.toolName === "hand_off_to_refund_agent")
                  handedOff = true;
                if (part.toolName === "hand_back_to_copper") handedBack = true;
                break;
              }
              case "tool-error": {
                const step = toolStep(part.toolCallId);
                if (step?.type === "tool") {
                  step.output = messageOf(part.error);
                  step.state = "error";
                }
                trace.toolEnd(part.toolCallId, messageOf(part.error), true);
                break;
              }
              case "text-delta":
                progress.reply += part.text;
                thisReply += part.text;
                break;
              case "error":
                throw part.error;
              default:
                continue;
            }
            update(snapshot(progress));
          }
        } catch (error) {
          trace.end({ costUsd: null, output: messageOf(error), ok: false });
          throw error;
        }

        // Tokens and cost for this agent's turn, added to the message's total.
        const usage = await Promise.resolve(result.totalUsage).catch(
          () => undefined,
        );
        const cost =
          usage?.inputTokens !== undefined && usage.outputTokens !== undefined
            ? costUsd(model, usage.inputTokens, usage.outputTokens)
            : null;
        metrics.inputTokens += usage?.inputTokens ?? 0;
        metrics.outputTokens += usage?.outputTokens ?? 0;
        metrics.costUsd += cost ?? 0;
        trace.end({ usage, costUsd: cost, output: thisReply, ok: true });

        // The customer must never be told a request was sent on or decided
        // unless a tool result shows it really was. If the agent that handles
        // refunds says so with nothing saved, its words are removed and it
        // tries again; if it still can't back it up, the customer is told
        // plainly nothing was sent.
        if (
          agent !== "shopping" &&
          isUnbackedClaim(thisReply, progress.steps)
        ) {
          progress.reply = progress.reply.slice(
            0,
            progress.reply.length - thisReply.length,
          );
          if (correction === undefined && run + 1 < MAX_RUNS) {
            correction = CORRECTION;
            update(snapshot(progress));
            continue;
          }
          progress.reply += UNBACKED_FALLBACK;
          thisReply = UNBACKED_FALLBACK;
          update(snapshot(progress));
        }

        // Who answers next? Only the code decides, from what the agent did.
        // A single agent never hands over, so its message ends here.
        if (agent === "single") break;
        if (agent === "shopping") {
          const safetyNet =
            !handedOff &&
            lastQuestion !== undefined &&
            looksLikeRefundRequest(lastQuestion.content);
          if (!handedOff && !safetyNet) break;
          progress.mode = "refund";
        } else {
          if (!handedBack) break;
          progress.mode = "shopping";
          // A hand-back with nothing said means "this isn't mine": Copper
          // answers the same question now. After a goodbye, the chat just waits.
          if (thisReply.trim()) break;
        }
        update(snapshot(progress));
      }

      // If a request was saved, the customer always hears what the app did,
      // even if the agent left it out of its own words.
      const receipt = receiptFor(progress.steps, progress.reply);
      if (receipt) progress.reply = `${progress.reply.trim()}\n\n${receipt}`;

      if (!progress.reply.trim()) progress.reply = APOLOGY;
      done(snapshot({ ...progress, status: "done" }));
    } catch (error) {
      ok = false;
      console.error("[support]", messageOf(error));
      done(
        snapshot({
          ...progress,
          reply: progress.reply.trim() || APOLOGY,
          status: "error",
        }),
      );
    } finally {
      metrics.latencyMs = Math.round(performance.now() - started);
      chat.end({ output: progress.reply, ok });
      options.onMetrics?.(metrics);
      // Send the trace now: a serverless function can freeze once it replies.
      await flushTraces();
    }
  })();

  return { progress: live };
}
