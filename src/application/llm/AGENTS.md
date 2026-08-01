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
- When a turn speaks and a **later turn speaks too**, the engine yields `TURN_SEPARATOR`
  (a blank line) as a content delta before the later turn's first word. Consumers flatten the
  stream by appending deltas, so without it one statement runs into the next —
  `…확인해볼게요."demo" 데이터소스를 찾았어요.` Emitted lazily, from the producer: a turn that only
  calls tools never triggers one, and chat, Slack and the OpenAI response would otherwise
  each have to re-derive a boundary only the loop knows about.
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
- **`dispatch_agents` is fan-out; `transfer_to_agent` is handoff.** One call runs several
  children at once and collects their answers, so it stays a *single* entry in call order —
  whatever ran before it in that order has already run — and the answers land in **one tool
  result**, spent from the same `MAX_TOOL_RESULT_CHARS_PER_TURN` budget as every other
  result. That is why it is its own tool rather than parallel transfers: a transfer's answer
  enters as a `postContextMessages` user turn, which no budget bounds at all.
  - Offered to **top-level runs only** (`input.canDispatch`, set by `executeAgent`). A child
    that could dispatch would multiply concurrent runs by transfer depth, and a subagent run
    does not pass through the run bracket — these children are outside the concurrency and
    cost guards, so `MAX_DISPATCH_TASKS` and that asymmetry are the only bounds on them.
  - Turn accounting is a transfer's: children start at `turn + 1`, the parent resumes at
    `turn + 2` however many ran, guarded by the same `turn + 2 >= maxTurn`.
  - Children advance through `mergeGenerators` (`src/shared/`), which keeps each one's return
    value at **its own index** — chunks interleave in arrival order, answers are collected in
    task order.
  - The budget is **split evenly** across tasks rather than spent in order: a first child
    answering at length would otherwise starve every task after it, which is the whole point
    of having asked several at once.
  - A task that cannot run (bad shape, unknown `image_ids`, past the width limit) keeps its
    place in the result carrying its reason, and does **not** cancel the others. The group is
    prefixed `Error:` only when *every* task failed — the trace recorder reads that prefix, so
    a partial failure must not report the whole call as failed.
  - **The returned text decides whether a task failed**, never the `error` chunks that went
    past. A child answers from a nested transfer's failure (it arrives as a tool error), and a
    deeper descendant's error travels out on that same stream — so treating either as the
    task's outcome throws away the answer it produced, and one recovered failure per task
    would report the whole call as failed. `observeChildFailure` exists only to say *why* a
    task came back empty; a child never throws, it yields an `error` chunk and returns `""`.
  - The message a task carries comes from `args`, **not** `displayArgs` — see the PII
    boundaries below. A child is on the far side of that boundary, like a transfer's.
- Turn guard: `turn >= maxTurn` (default 50) silently ends the loop. Transfer guard:
  `turn + 2 >= maxTurn` rejects a transfer (the child starts at `turn + 1` and the parent
  resumes at `turn + 2`, so two turns must remain). The child's own consumption is NOT
  charged against the parent's budget — the parent always resumes at `turn + 2` — but the
  child's ceiling is clamped to the parent's in `runProject.ts`, so a child version with a
  larger `maxTurn` cannot raise the limit the run started under.

## System prompt assembly (`buildAgentSystemPrompt`)

The version's own text comes first, then — when the run has anything to append — a `---`
break and the engine's blocks: the **run clock**, then the **caller block** (who is asking,
for versions that opt into `callerContext`), then a `# Runtime capabilities` block
holding the `##` sections (that one only when the run resolved at least one capability).
`withEngineBlocks` owns that boundary for this and for the single-shot assembly
(`buildPromptMessages`) alike; a second copy of the rule would drift the moment one path
grew a block the other did not have. Rules that keep the halves from restating each other:

- **The block is the authority on what exists, the version's text on who the agent is.**
  The break exists because the generated `##` headings are otherwise indistinguishable
  from the author's own, and because the routing rule below needs "your instructions"
  to have a referent. Nothing to append means the author's text
  byte-for-byte — no boundary is announced with nothing behind it.
- **The clock sits outside the capability block, ahead of it.** It says when the run
  happens, which is not something the run can *reach*, and the framing speaks only for the
  sections that follow it. It arrives as `input.now` rather than being read here — the
  engine stays pure and its tests stay off the real clock. `runClock`
  (`execution/deps.ts`) is the one place the real clock is read, and `executeAgent` pins it
  for the whole run: a subagent reading its own would disagree with its parent across a
  midnight boundary, which is the confusion the clock exists to remove. UTC, labelled, to
  the minute — a prompt that changed every second would defeat provider prompt caching.
- **Capability routing is stated once, in the framing, and names only what the run has.** Each
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
wrapper in `subagentRunner.ts` stamps both once per transfer level: it preserves an existing
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
  because a tool asked to mail `a@b.com` needs the address, not a token. A subagent is the
  opposite — for `transfer_to_agent` and for every task of `dispatch_agents`, both of which
  read their message from `args`: the child receives the masked message **and a masked
  transcript** — the
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
