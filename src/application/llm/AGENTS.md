# LLM Engine — invariants to preserve

Read this before editing `engine.ts` or `pii.ts`. The engine is pure logic with everything
injected (`AgentDeps`), tested with no network/DB via `tests/fakeChannel.ts`.

## Tool loop (`runAgent`)

- All `tool_calls` of one model response aggregate into **one** assistant message, then all
  tool results append, then the loop recurses with `turn + 1`. Never split a response's
  tool calls across assistant messages — providers reject orphaned tool results.
- Builtin tools are intercepted **before** MCP dispatch, in this order: `Skill`
  (progressive skill loading), `transfer_to_agent` (subagent transfer), `GenerateImage`.
  Anything else goes to `deps.callMcpTool`.
- Turn guard: `turn >= maxTurn` (default 50) silently ends the loop. Transfer guard:
  `turn + 2 >= maxTurn` rejects a transfer (the child starts at `turn + 1` and the parent
  resumes at `turn + 2`, so two turns must remain). The child's own consumption is NOT
  charged against the parent's budget — the parent always resumes at `turn + 2`.

## Author contract

Top-level chunks are **unauthored** (`author === undefined`); only subagent chunks carry
`author` (stamped by the `runSubagent` wrapper, re-stamped at every recursion level).
`isTopLevelChunk()` in `src/domain/llm/types.ts` is the single owned predicate — every
consumer (chat persistence, Slack, OpenAI reshaping, A2A, browser client) filters with it.
Do not tag top-level chunks with an author; three consumers persist/accumulate only
unauthored content.

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
