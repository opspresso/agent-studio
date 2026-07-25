# LLM Engine — invariants to preserve

Read this before editing `engine.ts` or `pii.ts`. The engine is pure logic with everything
injected (`AgentDeps`), tested with no network/DB via `tests/fakeChannel.ts`.

## Tool loop (`runAgent`)

- All `tool_calls` of one model response aggregate into **one** assistant message, then all
  tool results append, then the loop recurses with `turn + 1`. Never split a response's
  tool calls across assistant messages — providers reject orphaned tool results.
- Builtin tools are intercepted **before** MCP dispatch, in this order:
  `transfer_to_agent` (subagent transfer), `GenerateImage`, `EditImage`, `Skill` (progressive
  skill loading). Anything else goes to `deps.callMcpTool`.
- Image handles: a per-run registry ids every usable image (`img_1`, `img_2`, …) — the
  inline `data:` images in the input messages, plus everything the run drew. `EditImage`
  and `transfer_to_agent`'s `image_ids` resolve an id to bytes, so the registry (not the dep)
  owns the bookkeeping; the model learns new ids from the image tool results and the input
  ones from the system prompt. The registry is populated when either use exists (an image
  dep, or a subagent to hand a picture to) — a run that can do neither skips it.
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

- **Masked on the way out**: system prompt, history messages, tool arguments — everything
  entering the channel or re-entering engine context stays masked.
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
