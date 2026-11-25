# Architecture

How the Copper State Labs app fits together. Each module adds a section at the
end (see [Adding a module](#adding-a-module)) when it changes how the app
works: new pages, tables or AI calls.

_Fictional — for educational use._

## The starter app (Module 0)

A Next.js app that builds, runs and deploys with **no environment variables**.
A Google AI Studio key is optional until a module needs one.

| Piece | Where | What it does |
|---|---|---|
| Pages | `app/` | `layout.tsx` sets the fonts and theme; `page.tsx` is the placeholder home page |
| Brand components | `components/copper/` | `Logo`, `SiteHeader`, `SiteFooter`, `ModeToggle` |
| UI kit | `components/ui/` (shadcn), `components/ai-elements/` (AI Elements) | The only UI libraries the app uses |
| Setup card | `components/setup-required.tsx` | `<SetupRequired service="ai" />`, shown instead of a page whose service isn't configured |
| Company catalog | `lib/copper/catalog.ts`, `lib/copper/data/catalog.json` | Product, plan and privacy facts from the Product Bible (Sections 3, 4, 8 and 10). Pages read prices and plan details from here instead of typing them (added in the Module 1 starter) |
| AI wrapper | `lib/ai/call.ts` | `callText` and `callObject`: every model call goes through these and is logged to the terminal |
| Models and prices | `lib/ai/models.ts`, `lib/ai/pricing.ts` | The approved Gemini models and their token prices |
| Module checks | `specs/module-N/`, `scripts/check.mjs` | Each module's spec, instructions, rubric and acceptance tests; `npm run check` runs them |

## Data flow

1. A user opens a page in `app/`.
2. Server code checks what's configured (`isAiConfigured()`). If the key is
   missing, the page renders `<SetupRequired />` instead of crashing.
3. Data comes from files under `lib/copper/data/`, except where a module has
   moved it to a database: Module 2 part 2 moves stock to a Supabase
   `inventory` table, read through `lib/copper/inventory.ts`. Facts that don't
   change daily (prices, colors) stay in the files.
4. AI requests go through `callText` / `callObject` in `lib/ai/call.ts`, which
   calls Google and then prints one `[ai_calls]` line: `module`, `feature`,
   `model`, tokens, `cost_usd`, `latency_ms`, `ok`.

```ts
const { text } = await callText(
  { module: 2, feature: "ask-copper" },
  { prompt },
);
```

## Two kinds of "AI tiers"

Don't mix these up:

- **Copper State Labs' product tiers** (On-device, Raw Ore, Refined, the
  Copper Cloud) are part of the fictional company. They are facts in the
  [Product Bible](copper-state-labs/product-bible.md) and rows in the `ai_tiers`
  table.
- **The models this app calls** are real Claude models listed in
  `lib/ai/models.ts`. Their cost is logged in `ai_calls`.

## Decisions

- **No environment variables required.** Every service is optional, so a fresh
  clone builds and deploys before any accounts are set up.
- **One AI wrapper.** Routing every call through `lib/ai/call.ts` gives one
  place to log cost and latency per module and feature.
- **No authentication or row-level security yet.** They arrive in a later
  module.

## Module 2: Ask Copper tools

**Summary:** the four tools the shopping chatbot can call, so prices, totals
and stock come from code and data instead of the model's memory.

| Piece | Where | What it does |
|---|---|---|
| Tools | `lib/copper/assistant/tools.ts` | `get_products`, `get_prices`, `calculate_cost`, `check_availability`, exported as `copperTools` |
| Data | `lib/copper/catalog.ts`, `lib/copper/inventory.ts` | Prices and colors from the catalog; stock read fresh from the Supabase `inventory` table by `readInventory()`, which returns `null` (so Copper says it can't check) when Supabase isn't set up or can't be read |

**Data flow:** model picks a tool and writes its input → zod schema validates
it → ordinary TypeScript reads the catalog or stock list → result goes back to
the model.

**Decisions and trade-offs:** input schemas are strict (unknown fields,
6 years or 1.5 years are rejected) so the app, not the model, protects the
business. Each line is rounded to cents before summing. Stock is never cached.
`not_a_color` is decided before stock is read, so it holds when stock is down.

**Risks and open questions:** the tools only read, so they can't change
anything. A blank `color` is treated as "every color".

### Ask Copper: the action and the panel

| Piece | Where | What it does |
|---|---|---|
| Server Action | `lib/copper/assistant/ask.ts` | `askCopper({ messages, useTools })` validates the request, returns `{ progress }` at once and reads the model stream in the background |
| Panel | `components/copper/ask-copper.tsx` | Floating launcher and Sheet; two separate chats (tools on / off); starter questions; shows `<SetupRequired />` without a key |
| Stations | `components/copper/ask-copper-stations.tsx` | Draws one answer: tools on offer, thinking, tool calls, "what's happening now" |
| Tool card | `components/copper/ask-copper-tool-card.tsx` | One tool call, always open: what Copper sent, what came back |
| Page / header | `app/page.tsx`, `components/copper/site-header.tsx` | Mounts the panel (with `isAiConfigured()`) and links to `#ask` |
| AI calls | `lib/ai/call.ts` (module 2, feature `ask-copper`) | `callStream` with `THOUGHT_SUMMARIES`; tools on adds instructions, the four tools and `stepCountIs(5)` |

**Data flow:** shopper question → panel (that chat's finished turns plus the
question) → `askCopper` → `callStream` → model → tool calls run in
`tools.ts` → each stream part updates a `Progress` → fresh copies go out through
a live value → `readLive()` in the panel redraws.

**Decisions and trade-offs:** a live value (not an API route) keeps the site to
one page. Each update is a full copy, so a missed update loses nothing. The
request is checked with zod (shape and size) because a Server Action is a public
POST endpoint. With tools off the model gets no instructions at all, so the
comparison shows what it does when nothing tells it to check.

**Risks and open questions:** cost per question is logged to `ai_calls`. The
default model is set in `lib/ai/models.ts` and can be changed with `AI_MODEL`.

## Module 4: Refund agent

**Summary:** a second agent that handles refund requests. Plain code decides
whether a refund is small enough to approve automatically; larger ones wait for
a person in the Refund Console. The AI handles the conversation, and code and
people handle the money. The full spec is
[`docs/refund-agent/spec.md`](refund-agent/spec.md).

| Piece | Where | What it does |
|---|---|---|
| Panels | `components/copper/refund-panels.tsx`, mounted in `app/page.tsx` | A "Copper Support" launcher and two slide-out panels (support chat and Refund Console), also opened by `/#support` and `/#refund-console`. The console is never shown by itself: the Support panel has a "Refund Console (staff)" link that shows it beside the chat on a wide screen or opens it as its own panel on a narrow one. The site stays one page |
| Support chat | `components/copper/support-chat.tsx` | A chat with two agents. Shows who has the chat, a "Request a refund" button and each tool call. The panel shows `<SetupRequired />` without an AI key |
| Switchboard | `lib/copper/assistant/support.ts` | `askSupport({ messages, mode })`: runs the agent that owns the mode, and changes the mode when an agent hands off or hands back |
| Copper's hand-off | `lib/copper/assistant/handoff.ts` | `hand_off_to_refund_agent`, the support instructions, and a keyword safety net |
| Refund agent | `lib/copper/assistant/refund-agent.ts` | Its instructions and four tools: `lookup_order`, `request_refund`, `check_refund_status`, `hand_back_to_copper` |
| Proof before words | `lib/copper/assistant/reply-check.ts` | Checks each Refund agent reply against the tool results: a claim that a request was sent on or decided needs a saved outcome behind it. Otherwise the reply is removed and the agent retries once; the app's own message is added if the agent leaves the outcome out |
| The rule | `lib/copper/refund-policy.ts` | `decideRefund`: approve, send to a person, or reject. Plain code, no AI |
| Saving and deciding | `lib/copper/refund-service.ts`, `lib/copper/refunds.ts` | `requestRefund` and `decideAsHuman`; the only file that reads or writes the refund tables |
| Refund Console | `components/copper/refund-console.tsx`, `lib/copper/refund-actions.ts` | Pending queue (reject needs a reason), auto-refund limit editor, refund log. Data is loaded by a Server Action each time the panel opens |
| Data | `supabase/migrations/20261117000000_refunds.sql`, `supabase/seed.sql` | Tables `orders`, `refunds`, `settings`, with demo orders |
| AI calls | `lib/ai/call.ts` (module 4, features `ask-copper-support` and `refund-agent`) | `callStream` with thought summaries; up to 5 steps per agent |

**Data flow:** customer message → support chat (sends the chat's `mode`) →
`askSupport` → the agent for that mode → tool call → `refund-service` → rules in
`refund-policy.ts` → `refunds` table → result back to the model → reply. Over the
limit, the row is saved as `pending`; a person's click in the Refund Console
changes it, and the agent reports it the next time `check_refund_status` runs.

**Decisions and trade-offs:**
- **The rule is code.** `request_refund` takes no limit input; the limit is read
  from the `settings` table, so no model can choose its own.
- **A separate support chat.** Module 2's tests fix Ask Copper's panel and tools,
  so the two-agent chat is a new panel and action and Ask Copper is untouched.
- **Panels, not pages.** Module 1's AC-1.4 requires a single page, so the chat
  and the console are slide-out panels on `/`.
- **The chat holds the mode.** No `chats` table: the page already holds the
  conversation, and a changed mode can't approve money anyway.
- **Proof before words.** A model can write "passed to a specialist" without calling
  the tool (seen live with order 1005), so the switchboard checks every Refund agent
  reply against the tool results and never lets an unbacked claim reach the customer.
- **Two names.** The AI is the refund assistant; only a person is a refund specialist.
- **The agents never talk to each other.** The code changes the mode; the agent
  and the human meet only in the database.
- **Money in whole cents** to avoid rounding mistakes.

**Risks and open questions:** the app has no login, so the console and the
refund tables are open to anyone with the public key: a class demo only (the
console shows no notice about this, so it is recorded here). The customer learns a human's decision only on their next
message (no live push). Cost per message is logged to `ai_calls`.

## Module 5: Safe to ship (CI, tracing, evals, single vs multi agent)

**Summary:** makes Ask Copper's support chat safe to ship. Tests and an AI-graded
quiz run on every pull request, every chat is recorded in Langfuse, and a
one-agent version of the chat lets us compare it with the two-agent design.
Langfuse is the only eval and monitoring tool.

| Piece | Where | What it does |
|---|---|---|
| CI | `.github/workflows/ci.yml` | `check` job (lint, typecheck, tests, build on three systems) and an `evals` job on every pull request. Branch protection on `main` requires them |
| Tracing | `lib/ai/trace.ts` | `startChatTrace` makes one Langfuse trace per customer message: the chat, each agent's turn, each tool call, and the tokens, cost and time of its model calls. `scoreTrace` attaches a score to a trace. Does nothing without the Langfuse keys, and can never break a chat |
| Switchboard | `lib/copper/assistant/support-core.ts` (`runSupport`), `support.ts` (`askSupport`) | The Module 4 logic moved into `runSupport`, now traced and with a `variant`. `askSupport` is the same public action and picks the variant from the server's `SUPPORT_AGENT_MODE` (`single`, otherwise two agents) |
| Single agent | `lib/copper/assistant/single-agent.ts` | One agent with Copper's four tools plus `lookup_order`, `request_refund`, `check_refund_status`; no hand-off. Same refund rules and same code deciding refunds |
| Golden set | `evals/golden-set.ts` | 12 questions (shopping, refund, safety), each with what a good answer does and two code checks: which tool must be used and which refund must be saved |
| AI judge | `evals/judge.ts` | A Gemini call through `lib/ai/call.ts` (module 5, feature `eval-judge`) gives each answer 1 to 5; 4 or more passes. The pass line is set in code |
| Eval runner | `evals/golden.eval.ts`, `vitest.eval.config.mts`, `npm run eval` | Runs each question, applies the code checks and the judge, sends `judge_score`, `judge_pass` and `case_pass` to Langfuse on the chat's trace, prints a score table (also on the pull request's check page) and fails below the pass rate (default 80%) |
| Safe data | `evals/fake-refund-store.ts` | In-memory copy of the demo orders. The evals swap it in for `lib/copper/refunds.ts`, so they never touch Supabase |

**Data flow:** a customer message → `runSupport` → `startChatTrace` → agent(s) and tools (each recorded) → reply → trace sent to Langfuse. For an eval: golden question → `runSupport` → code checks → AI judge → scores on that chat's Langfuse trace → report and pass/fail.

**Running it:**
- `npm run eval` runs the two-agent chat. `EVAL_VARIANTS=single npm run eval` or `EVAL_VARIANTS=both npm run eval` runs the one-agent design, or both and a comparison table. `EVAL_CASES=price-home,refund-no-order` runs only some questions.
- Keys, set in `.env.local` and as GitHub Actions secrets: `GOOGLE_GENERATIVE_AI_API_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`. To run the live site as a single agent, set `SUPPORT_AGENT_MODE=single`.
- In Langfuse, every trace is tagged `variant:multi` or `variant:single`, and eval traces are also tagged `eval` and `case:<id>`, so the two designs can be filtered and compared on score, cost and latency.

**Decisions and trade-offs:**
- **Hand-written traces instead of the AI SDK's automatic telemetry.** The automatic kind is new in this AI SDK version and its Langfuse output isn't something we could confirm. Writing the trace ourselves gives exactly what was asked for (which agent, which tools, tokens, cost, time) from the numbers the app already has.
- **Code checks plus a judge.** A friendly answer can hide a wrong action (saying "approved" when the refund is pending), so the saved refund and the tools used are checked by plain code, and the judge reads the real tool results.
- **The pass line is in code.** The judge only scores; `PASS_SCORE` decides.
- **Evals use fake data, never Supabase.** They create refunds and change orders; doing that to the real tables would break the demo.
- **The design is chosen by the server, not the request,** so a visitor can't switch agents.
- **CI evals run the two-agent design only,** to save AI quota. The comparison is run on demand.

**Risks and open questions:** every eval run spends AI quota (about 3 to 5 model calls per question, plus one for the judge), and the free Gemini tier has a small daily limit, so CI needs a key with enough quota. A judge is a model and can be wrong, which is why the key checks are plain code. Traces store the customer's message and the reply; the demo has no real customer data, but a real deployment would need a privacy decision first.

## Adding a module

When a module changes how the app fits together, add a section here:

```md
## Module N: <feature name>

**Summary:** one or two sentences: what this adds and why.

| Piece | Where | What it does |
|---|---|---|
| Page / route | `app/...` | |
| Components | `components/...` | |
| Data | `lib/copper/data/...` | Data files added |
| AI calls | `lib/ai/call.ts` (module, feature) | Model, prompt purpose, expected cost per call |

**Data flow:** user action → page → server code → database / model → response.

**Decisions and trade-offs:** what you chose, the alternatives, and why.

**Risks and open questions:** cost, privacy, accuracy or safety risks, and how
you handle them.
```
