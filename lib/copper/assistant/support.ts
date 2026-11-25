"use server";

// Refund agent: the "switchboard" for the Copper Support chat. Each message
// goes to one of two agents, depending on the chat's mode:
//   shopping: Copper, with its four shopping tools plus a hand-off tool
//   refund:   the Refund agent, with its own instructions and tools
// The agents never talk to each other. When one hands off (or hands back), the
// mode changes and the other agent answers. This is a separate action from
// askCopper (the Ask Copper panel), which stays exactly as Module 2 built it.
//
// The working parts are in support-core.ts. Module 5 adds an optional
// SUPPORT_AGENT_MODE=single, which swaps the two agents for one agent with
// every tool, so the designs can be compared.
import { z } from "zod";
import {
  runSupport,
  type SupportRequest,
  type SupportResult,
} from "@/lib/copper/assistant/support-core";

export type {
  SupportMessage,
  SupportMode,
  SupportProgress,
  SupportRequest,
  SupportResult,
} from "@/lib/copper/assistant/support-core";

// A Server Action is open to anyone who can send the POST, so the request is
// checked for shape and size before it reaches a model.
const requestSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            content: z.string().max(4000),
          })
          .strict(),
      )
      .min(1)
      .max(40),
    mode: z.enum(["shopping", "refund"]),
  })
  .strict();

export async function askSupport(
  request: SupportRequest,
): Promise<SupportResult> {
  const parsed = requestSchema.parse(request);
  // The design is chosen by the server's own setting, never by the request,
  // so a visitor can't switch it.
  const variant =
    process.env.SUPPORT_AGENT_MODE === "single" ? "single" : "multi";
  return runSupport(parsed, { variant });
}
