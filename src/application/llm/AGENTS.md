# LLM Engine — invariants to preserve

Read this before editing `engine.ts` or `pii.ts`. The engine is pure logic with everything
injected (`AgentDeps`), tested with no network/DB via `tests/fakeChannel.ts`.

## Tool loop (`runAgent`)

- All `tool_calls` of one model response aggregate into **one** assistant message, then all
  tool results append, then the loop recurses with `turn + 1`. Never split a response's
  tool calls across assistant messages — providers reject orphaned tool results.
- A builtin serves a call **only when that builtin was offered this run**.
  `buildAgentTools` returns the names it pushed and the loop intercepts exactly those, so a
  name a builtin did not claim (no skills connected → no `Skill` tool) belongs to whoever
  declared it — `deps.callMcpTool`. Never gate interception on a dep instead: every agent run
  gets `loadSkillContent`, so the dep says nothing about what the model was offered.
  `BUILTIN_TOOL_NAMES` is reserved when MCP aliases are allocated, before the run knows which
  builtins it will offer, so an MCP tool never carries a name a builtin might claim.
- Dispatch of one response: every call is announced first, then the **MCP calls run
  concurrently** (≤5 in flight) while builtins run strictly in call order — a transfer moves
  the turn budget and the image tools mutate the image registry. Results, tool messages and
  the assistant message's `tool_calls` all stay in call order; a dispatcher that throws still
  tears the run down, at its position in that order.
- One turn's tool-result text is capped (`MAX_TOOL_RESULT_CHARS_PER_TURN`), spent in call
  order. A truncated result says so; one that no longer fits is returned as `Error: …`, which
  also surfaces the exhaustion as a failed span in the trace.
- A tool result that begins with `Error: ` means the call failed — the shared convention for
  every producer (engine builtins, the skill loader, `ToolManager`). The trace recorder reads
  that prefix; a new producer that invents its own wording records failures as successes.
- An MCP tool may return **images** (`McpToolResult.images`). A `tool` message is text-only,
  so the bytes ride on a follow-up **user** message appended after that turn's tool results —
  the same route a transfer's answer takes — while the tool result text says so and names the
  ids (only when an image tool or a transfer can act on them). Accepted only when the model
  takes image input; otherwise the result says they were dropped, because sending parts a
  text-only model rejects fails the whole turn. Capped per turn by `MAX_ATTACHMENTS`, and once
  images are in context a fallback model that cannot read them is dropped.
- Image handles: a per-run registry ids every usable image (`img_1`, `img_2`, …) — the
  inline `data:` images in the input messages, plus everything the run drew. `EditImage`
  and `transfer_to_agent`'s `image_ids` resolve an id to bytes, so the registry (not the dep)
  owns the bookkeeping; the model learns new ids from the image tool results and the input
  ones from the system prompt's `## Available Images` section — which is present whenever
  those tools are offered, even before the first image exists (the tool descriptions'
  only documentation is a pointer to it). The registry is populated when either use exists
  (an image dep, or a subagent to hand a picture to) — a run that can do neither skips it.
- A transfer passes the model-written message **and** the bytes of any `image_ids`, so a
  child edits the real picture instead of a description of it. An unknown id fails the
  transfer with the available ids listed, rather than silently transferring without it.
- Turn guard: `turn >= maxTurn` (default 50) silently ends the loop. Transfer guard:
  `turn + 2 >= maxTurn` rejects a transfer (the child starts at `turn + 1` and the parent
  resumes at `turn + 2`, so two turns must remain). The child's own consumption is NOT
  charged against the parent's budget — the parent always resumes at `turn + 2`.

## Author contract

Top-level chunks are **unauthored** (`author === undefined`); only subagent chunks carry
`author`. `isTopLevelChunk()` in `src/domain/llm/types.ts` is the single owned predicate —
every consumer (chat persistence, Slack, OpenAI reshaping, A2A, browser client) filters with
it. Do not tag top-level chunks with an author; three consumers persist/accumulate only
unauthored content.

`author` is the **innermost** agent and `authorPath` is the chain that produced the chunk,
outermost first — `["sample-agent", "simple-image"]` for a depth-3 run. The `authored()`
wrapper in `runProject.ts` stamps both once per transfer level: it preserves an existing
author (a middle hop must not claim a grandchild's output) and prepends its own name to the
path. `traceId` is the opposite — each level overwrites it with its own, because a parent's
trace links one step down, not to the deepest run.

## Fallback semantics

On a retryable error (429/5xx) **before the first chunk**, retry once with
`fallbackModel`. After the first chunk has been yielded, a failure becomes an `{error}`
chunk — never a retry, never an exception. Usage is always recorded under the model that
actually served the call (`modelUsed`), at that model's rate.

## PII filtering boundaries

When `parameters.piiFiltering` is on, a per-run `PiiFilter` maps originals ⇄
format-preserving `[[PII:…]]` tokens:

- **Masked on the way out**: system prompt, history messages, and the tool-call arguments
  recorded on the assistant message — everything entering the channel or re-entering engine
  context stays masked.
- **Not masked on outbound tool dispatch**: `callMcpTool` is handed the *restored* arguments,
  because a tool asked to mail `a@b.com` needs the address, not a token. A subagent transfer is
  the opposite: the child receives the masked message and the parent's filter restores its
  output. So `piiFiltering` bounds what the LLM and the engine context see — **not** what a
  third-party MCP server sees. Keep it that way deliberately, or make it a per-server choice;
  do not change it by accident.
- **Restored on the way in**: every yielded `delta` is restored through a
  `PiiStreamRestorer`, which buffers the longest suffix that could be a partial
  replacement token across chunk boundaries. Flush restorers on error paths too.
- The same filter instance crosses subagent transfers (`runSubagentWithPii`), so a child's
  output restores with the parent's mapping.
- Off-toggle must remain byte-identical to the unfiltered path
  (`tests/piiFiltering.test.ts` pins this).

## Usage recording

The engine calls `deps.recordUsage` once per model call *inside* the loop and also yields
a `usage` chunk. Agent runs inject an aggregator (`createUsageAggregator`) that buffers
and flushes once per (project, date, model) in a `finally` — telemetry failures are
logged, never thrown.
