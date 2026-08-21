# LLM Engine — invariants to preserve

Read this before editing `engine.ts`, its two internal modules — `agentAssembly.ts` (what a
run is told it can do) and `toolResultBudget.ts` (what a result may cost, and what it has to
do) — or `pii.ts`. The engine is pure logic with everything injected (`AgentDeps`), tested
with no network/DB via `tests/fakeChannel.ts`; `engine.ts` re-exports both modules' public
surface, so callers keep one import path.

**This file holds what must not break.** Why the loop is shaped this way — what a version
declares, where the budget's ceiling comes from, why an image dep is an opt-in — is
[docs/design/execution.md](../../../docs/design/execution.md), and what wraps a run before it
reaches here is [docs/ARCHITECTURE.md](../../../docs/ARCHITECTURE.md#런-브래킷).

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
- Dispatch of one response: every call is announced first, then the **MCP calls, `FetchUrl` and
  `SaveFile` run concurrently** (≤5 in flight, one shared pool) while the *other* builtins run
  strictly in call order — a transfer moves the turn budget and the image tools mutate the image
  registry. The two joiners do neither: `FetchUrl`'s bytes are registered below, in order, the
  way an MCP tool's are, and leaving it sequential would make three links in one answer cost
  three round trips — slower than the standalone server it replaced; `SaveFile` touches nothing
  the loop carries at all. Results, tool messages and the assistant
  message's `tool_calls` all stay in call order; a dispatcher that throws still tears the run
  down, at its position in that order. A *fetch* that throws does not: an unreachable address
  is the tool reporting an outcome, not a transport fault, so it becomes an `Error: …` result.
- **A call's arguments are bounded by size, in both copies, before either is kept.** They
  outlive the call twice and nothing else cuts either one. The **assistant message** carries
  them back to the provider on every remaining turn — `contextBudget` charges
  `JSON.stringify(tool_calls)` and only `fitText` can cut, which never touches an assistant
  message, so a megabyte of `SaveFile` content is ~350k tokens per turn and past the window of
  most of the catalog: an unretryable 400 mid-run, after the file was delivered. The
  **announced copy** is rendered by the chat view, buffered by the run log, and persisted onto
  one 400KB DynamoDB item whose write fails *silently*, taking the reply the reader just
  watched stream — content and reasoning are truncated onto that item, `tool_calls` is the axis
  that is not. `boundToolArgs` swaps any value past `MAX_TOOL_ARG_BYTES` for its size, and
  `boundArgumentText` cuts a call whose arguments never parsed, which is how an oversize one
  most often arrives (the provider cuts the turn mid-file; the accumulator has no cap).
  **Keyed to size, never to a tool name** — a document renderer takes the document's text, and
  a model that emits a long string as an array of lines arrives under a name nothing
  anticipated. The model loses nothing: the tool result on the same turn already said the file
  exists and what it is called.
- **Which copy of the arguments a builtin is dispatched from is a PII decision, not a
  preference.** `args` is masked and `displayArgs` has the values restored. Anything crossing to
  another model — a transfer's `message`, a dispatch's `tasks` — reads `args`. Anything reaching
  a person or an outside system that the caller's own context already trusts — MCP dispatch,
  the image prompts, `SaveFile`'s file — reads `displayArgs`; a report saved from the masked
  copy reaches the person who asked for it full of their own placeholders.
- A returned picture takes one path, whoever produced it. `FetchUrl` normalises onto
  `McpToolResult`, so the image budget, the `img_N` registration, the rejection notice for a
  model that cannot see one, and the follow-up user message carrying the bytes are all written
  once. `McpToolResult.files` is the exception that proves it: a file **never enters the
  context** — a model cannot read a DOCX and the result text names it — so it is yielded as
  `EngineChunk.file` and touches no budget at all.
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
  each have to re-derive a boundary only the loop knows about. **Reasoning follows the same
  rule** on its own axis, when it is emitted at all.
- **`reasoningTrace` gates the yield of `delta.reasoningContent`, and nothing else.** The
  version's opt-in decides who may *read* the thinking. `reasoningText` accumulates either
  way and is put back on that turn's assistant message as `reasoning_content`, because the
  thinking has to stay attached to the turn that produced it and to the tool calls that turn
  declared — deleting the accumulation because it looks unused with the flag off changes what
  the model is sent. Two strings are live at once: the accumulator holds what the provider
  sent (masked, since that is what goes back), the yielded chunk holds the restored copy.
  Gating downstream instead would put the parameter in nine places — eight consumers and the
  run log, whose 350KB buffer a token-at-a-time axis fills on its own.
- One turn's tool-result text is capped (`MAX_TOOL_RESULT_CHARS_PER_TURN`), spent in call
  order. A truncated result says so; one that no longer fits is returned as `Error: …`, which
  also surfaces the exhaustion as a failed span in the trace.
- **Every result leaves through the turn's `toolResult` emitter**
  (`createToolResultEmitter`), which owns the four things a result has to do and the order
  they happen in: mask it, charge it, hand the **restored** text to the reader, keep the
  **masked** one in the context. Eleven branches spelled that out for themselves and had
  already diverged. The order is the part worth protecting — a branch that stored the
  restored text would put back exactly what `piiFiltering` removed, silently and for one tool
  only. Two knobs, both narrow: `stored` for the single result whose context copy differs
  from its display copy (a transfer's marker, against the protocol's null placeholder), and
  `bounded` for text whose length is the engine's own — a refusal it wrote, not a payload it
  received. Those are **charged and returned whole** (`ToolResultBudget.charge`) rather than
  fitted, because their wording is the point: replacing "max_turn reached before transfer"
  with "this turn's budget is exhausted" trades the reason for the accounting. A branch that
  produces both — the image builtins' argument refusals *and* their provider error bodies
  share one variable — decides per outcome, not per branch. Absent is the safe default:
  anything a provider, a tool or a child sized goes through the fit.
- The **run context budget** (`contextBudget.ts`, single owner of the derivation and the
  chars→tokens estimate) sits under every per-turn cap. Its window is the minimum with the
  **effective** fallback — the one left after `imageEligibleFallback`, because capping to a
  window the dropped fallback will never serve starved image runs at a fraction of their
  capacity. Charge sites, all of them: the assembled `messages` and the tool-definition JSON
  at run start, each turn's assistant message, every tool result — the image builtins'
  result strings included, whose failure path carries an unbounded provider error body — as
  `createToolResultBudget` fits it, a transfer's answer before it becomes a "For context"
  message, and the MCP-image companion message at the flat per-image rate — never the base64
  length. **Everything inserted is charged, as the exact string inserted**: with PII
  filtering on that is the *masked* text (mask tokens run longer than what they replace, so
  pricing the raw text undercounted — and a fit that cut through a raw address would leave a
  fragment the mask no longer recognises), the run-budget marker is reserved *inside* the
  fit (`fitText`'s `suffix`), and the per-turn marker, wrappers and omission strings are
  charged where they are appended — post-exhaustion ones as debt, since the tool protocol
  forces a result message per call. That holds for the engine's own refusals too: they skip
  the *fit*, never the charge. When both budgets cut one result, only the binding
  constraint's marker is appended — a per-turn "kept N of M chars" claim re-cut by the run
  fit would assert a length the final text no longer has — and the turn is debited what
  actually entered the context, so a later call this turn is not starved against text the
  context never received. A cut is never silent: the result text carries a marker and the
  run warns once. Exhaustion does not end the loop — the model reads the
  omission errors and wraps up, and the turn guard stays the hard stop. No budget exists for
  an unregistered model (no window to derive from), for a `maxTokens` that leaves the window
  no capacity (the provider rejects that coherently; a zero budget only blames itself), or
  for single-shot runs (nothing accumulates).
- A tool result that begins with `Error: ` means the call failed — the shared convention for
  every producer (engine builtins, the skill loader, `ToolManager`). The trace recorder reads
  that prefix; a new producer that invents its own wording records failures as successes.
- An MCP tool may return **images** (`McpToolResult.images`). A `tool` message is text-only,
  so the bytes ride on a follow-up **user** message appended after that turn's tool results —
  the same route a transfer's answer takes — while the tool result text says so and names the
  ids (only when an image tool or a transfer can act on them). **The model's capability
  decides the context copy, never the delivery**: a picture is yielded whatever the model can
  read, because the person who asked for the screenshot is not the model — the rule
  `EngineChunk.file` already follows — and only the follow-up message is withheld, since
  sending parts a text-only model rejects fails the whole turn. Such a run still gets ids: a
  model that cannot see a picture can hand it to an agent that can. Capped by
  `MAX_ATTACHMENTS` **per turn**, which bounds delivery too — nothing else bounds how many
  pictures one call returns — and per turn rather than per run, because the cap bounds one
  request and spending it once would leave a screenshot agent blind after its first. Once
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
- **An agent the run never offered is refused before the transfer is attempted**, with the
  offered names listed — the same answer an unloadable skill and an unknown image id get.
  `agent_name` is an enum on both tools, but an enum is advisory and a model that invents a
  name is routine. Attempted, it was refused a layer down as an authored `error` chunk, which
  the engine then reported as a lost delegation: a warning in the user's face for a model
  typo, a tool-result line promising an answer that was never coming, and "the agent returned
  no answer" for the model, with no hint of the alternatives. The list checked against is the
  one `assembleAgentRun` **offered** (it returns it, like `builtinNames`), never
  `input.subagents` — what was offered and what is served come from one value. A dispatched
  task is refused in the slot its shape already has, so the tasks beside it still run. The
  runner's own unknown-name guard stays as the backstop.
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
- **A transfer that came back empty says why**, through the same `observeChildFailure` a
  dispatched task uses and under the same rule: **the returned text decides**, and the
  captured error only ever explains an *empty* answer. A child never throws, so its failure
  exists solely as an authored `error` chunk — and every consumer drops those, on the
  grounds that the parent answers past them. That was true of `dispatch_agents`, which folds
  the reason into its tool result, and false of a transfer, which left the model an empty
  "For context" turn and no account of it; the model wrote one of its own, and the same
  provider refusal that reported itself through the `GenerateImage` builtin vanished through
  a transfer to an image project. A transfer additionally emits **one `warning`** when the
  answer is empty, which a dispatch does not need: a dispatch's reason rides in a tool result
  the reader can see, while a transfer's marker is a fixed string that never varies. The
  agent is named inside the warning text, because warnings surface without author labels.
- **`dispatch_agents` is fan-out; `transfer_to_agent` is handoff.** One call runs several
  children at once and collects their answers, so it stays a *single* entry in call order —
  whatever ran before it in that order has already run — and the answers land in **one tool
  result**, spent from the same `MAX_TOOL_RESULT_CHARS_PER_TURN` budget as every other
  result. That is why it is its own tool rather than parallel transfers: a transfer's answer
  enters as a `postContextMessages` user turn, which no budget bounds at all.
  - Offered to **top-level runs only** (`input.canDispatch`, set by `executeAgent`). A child
    that could dispatch would multiply concurrent runs by transfer depth, and a subagent run
    does not pass through the run bracket — so the **concurrency** guard does not reach these
    children, and `MAX_DISPATCH_TASKS` plus that asymmetry are the only bounds on how many run.
    Spend is bounded: `subagentRunner` checks the child project's own cost limit where the
    child's version resolves, and the parent settles that project's thresholds after its usage
    flush (see [ARCHITECTURE.md](../../../docs/ARCHITECTURE.md#런-브래킷)).
  - Turn accounting is a transfer's: children start at `turn + 1`, the parent resumes at
    `turn + 2` however many ran, guarded by the same `turn + 2 >= maxTurn`.
  - Children advance through `mergeGenerators` (`src/shared/`), which keeps each one's return
    value at **its own index** — chunks interleave in arrival order, answers are collected in
    task order.
  - The budget is **split evenly** across tasks rather than spent in order: a first child
    answering at length would otherwise starve every task after it, which is the whole point
    of having asked several at once. Split over what the turn has **left**
    (`ToolResultBudget.remaining`), not over `MAX_TOOL_RESULT_CHARS_PER_TURN` — a dispatch is
    one call among however many the model made in the same response, and sizing the shares
    against the cap built a group larger than the budget, which the single `fit` then cut from
    the tail. The group's `Error:` prefix, the section headings, the reasons of tasks the plan
    refused, and room for each share's truncation marker come off the top first: they are the
    engine's own strings and are never the thing to cut. The reason a task that *ran* and came
    back empty carries is different — child- or provider-written text whose length nothing on
    this side decides — so it is fitted to the task's share like an answer.
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
- **The last turn is a wrap-up**: at `turn === maxTurn - 1` a run that has tools is offered
  none and told why (`finalTurnNotice`, carried as a `user` turn like every other statement
  the loop inserts). Withholding them is the mechanism, not the notice — a model still
  looping at the ceiling is exactly the one that ignores an instruction to stop, and the
  guard below would then end the run with a warning where the answer should be, every turn
  paid for and nothing to show. Calls that arrive anyway are **not dispatched**: no turn will
  read their results. Either outcome ends `turn-limit` — the answer is what the run could say
  with its budget spent, not the one it would have written with turns left, and `done` would
  erase that difference. `turnLimitWarning` owns all four wordings (answered or not, run or
  subagent).
- Turn guard: `turn >= maxTurn` (default 50) ends the loop, and it announces itself: a
  `warning` chunk names the limit for the user, then a `finishReason: "turn-limit"` chunk
  names it for consumers. It is reached only by a run that never got a wrap-up turn — a
  subagent handed `startTurn >= maxTurn`, or a delegation that moved the counter past the
  last turn. A subagent run's warning names its agent instead of "the run" —
  warnings surface without author labels everywhere, so the generic wording next to the
  parent's finished answer read as the parent's ending — and it says "subagent", not which
  mechanism started it: the continued turn counter cannot tell a transfer from a dispatch.
  A final turn the provider cut at
  its output cap (`finish_reason: "length"` on the channel) is announced the same way as
  `finishReason: "output-limit"` — `done` would claim the model finished on its own. A cut
  turn that still carries tool calls does not end the run: the cut is announced once as a
  `warning`, calls whose arguments arrived whole run normally, and one whose arguments did
  not parse is answered `Error: …` and never dispatched — parsing the fragment to `{}`
  would run a call the model never made and report it as a success.
  Normal completion stays `done: true`, byte-identical, and `chunkTermination` /
  `runTermination` (`src/domain/llm/types.ts`) are the only readers of the
  done/finishReason/error → reason mapping. Transfer guard:
  `turn + 2 >= maxTurn` rejects a transfer (the child starts at `turn + 1` and the parent
  resumes at `turn + 2`, so two turns must remain). The child's own consumption is NOT
  charged against the parent's budget — the parent always resumes at `turn + 2` — but the
  child's ceiling is clamped to the parent's in `subagentRunner.ts`
  (`Math.min(version.maxTurn ?? maxTurn, maxTurn)`), so a child version with a larger
  `maxTurn` cannot raise the limit the run started under.

## Run assembly (`assembleAgentRun`)

**One place decides what a run is told it can do**, and both `runAgent` and the Playground
preview go through it. The builders below each had a single owner already; the *arguments* did
not — two call sites spelled out eight and seven positional arguments apiece, and had drifted:
the preview omitted the last one, so a version that opted into `callerContext` previewed a
prompt without the caller block every real run carries. `tests/architecture.test.ts` now fails
on a second caller of either builder.

**A capability is derived from the deps, never from the version.** A builtin the run cannot
actually perform is not offered and not described: no `loadSkillContent` means no `Skill` tool
even with skills bound, and no `runSubagent` means no transfer tool, no `dispatch_agents`, and
no delegation section in the prompt. Both of those used to be gated on the *list* being
non-empty, so a run advertised them and then answered a call with an error about arguments.

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

Termination chunks follow the same rule: only a **top-level** `done`/`finishReason` speaks
for the stream. An authored one is informational — a child's ending is absorbed into the
parent's tool result, and the end of the child's stream is already said by `authorDone` — so
a consumer must never read a child's turn limit as the run's.

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
