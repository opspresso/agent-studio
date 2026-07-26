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
- Every call carries an id unique across the **run**, not just the response: a provider that
  omits ids (some OpenAI-compatible gateways do) gets `call_1`, `call_2`, … from a counter
  shared by every turn. Results are keyed by id, and a chat persists one assistant message
  holding every turn's calls — per-response uniqueness would put duplicate `tool_call_id`s
  on it and the next request would be rejected.
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
  text-only model rejects fails the whole turn. Capped by `MAX_ATTACHMENTS` **per turn** —
  the cap bounds one request, so it resets each turn rather than leaving a screenshot agent
  blind after its first — and once images are in context a fallback model that cannot read
  them is dropped.
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
- A transfer also carries the **conversation so far**, as text — never as messages. A
  child is a different agent with its own system prompt: replayed turns would have it read
  the parent's answers as its own, and the parent's `tool_calls` would name tools the child
  never declared. `buildTransferTranscript` renders `input.messages` (not the loop's
  growing array, which holds this run's own tool traffic and its synthesized "For context"
  turns) newest-first within `MAX_TRANSFER_CONTEXT_CHARS`, masks it once with the run's PII
  filter, and **excludes the turn being answered** — the message already is that request,
  and a one-turn conversation would otherwise carry only itself. What was dropped is said
  both in the transcript (the child sees nothing else) and once as a `warning` at the first
  transfer that carries a clipped one. The transcript is handed to `runSubagent`
  *separately* from the message because only the runner knows the child's kind:
  `runLocalSubagent` folds it in for an agent or prompt child and passes it on so a
  grandchild inherits the original conversation rather than a transcript of a transcript,
  while an **image child gets the bare message** — that message is its image prompt, so a
  conversation prepended to it would be drawn.
- Turn guard: `turn >= maxTurn` (default 50) silently ends the loop. Transfer guard:
  `turn + 2 >= maxTurn` rejects a transfer (the child starts at `turn + 1` and the parent
  resumes at `turn + 2`, so two turns must remain). The child's own consumption is NOT
  charged against the parent's budget — the parent always resumes at `turn + 2` — but the
  child's ceiling is clamped to the parent's in `runProject.ts`, so a child version with a
  larger `maxTurn` cannot raise the limit the run started under.

## System prompt assembly (`buildAgentSystemPrompt`)

The version's own text comes first, then — only when the run resolved at least one
capability — a `---` break and a `# Runtime capabilities` block holding the `##` sections.
Two rules keep the halves from restating each other:

- **The block is the authority on what exists, the version's text on who the agent is.**
  The break exists because the generated `##` headings are otherwise indistinguishable
  from the author's own, and because the precedence rule below needs "your own
  instructions" to have a referent. A run that reaches nothing gets the author's text
  byte-for-byte — no boundary is announced with nothing behind it.
- **Precedence is stated once, in the framing, and names only what the run has.** Each
  section documents what is specific to it (an MCP table says where the tools come from;
  the agent table says a `message` is the whole request and must not be sent twice) and
  never its own "use me when…" — several unranked policies leave the model no way to
  choose. The same rule governs the `## Available Images` empty state: it lists generate/
  edit only when the image tools are offered, and "a tool returns one" only when MCP tools
  exist, because promising an id from a source the run does not have is the same defect as
  advertising a skill that can never load.

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
  the opposite: the child receives the masked message **and a masked transcript** — the
  conversation crosses that boundary the same way the message does — and the parent's filter
  restores its output. So `piiFiltering` bounds what the LLM and the engine context see —
  **not** what a third-party MCP server sees. Keep it that way deliberately, or make it a
  per-server choice; do not change it by accident.
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
