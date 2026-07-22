# Milestones

Feature roadmap derived from a gap analysis against a production-grade internal LLM
platform with the same domain (prompt/agent/cost management), plus a full domain-layer
audit of this codebase. Agent Studio already covers the core execution layer (engine tool
loop, progressive skill loading, subagent transfer, fallback, Slack/A2A/MCP, usage
aggregation); the milestones below fix correctness gaps the audit surfaced and fill the
layers that production operation proved essential — observability, cost control,
evaluation, and deploy history.

Ordering reflects value-per-effort: M1–M2 are small correctness/hardening fixes on the
money and secret paths, M3–M6 build on data and schemas that already exist, M7–M10 round
out the platform, and the backlog items need real demand before investing.

## M1 — Cost ledger integrity

**Why**: the cost pipeline silently under-records. `calculateCost`/`calculateImageCost`
return `$0` for any model id missing from the catalog with no signal, and `Version.model`
is an open string — a typo or a new model bills as free. `ModelPricing.perImage` is set on
four image models but read nowhere; for `xai/grok-imagine-image`/`-quality` it is the
*only* price (token rates are 0), so every generation records `$0`. In a cost-management
product the ledger must not lie.

**Scope**

- Charge per-image-billed models by generated-image count × `perImage` in
  `calculateImageCost`.
- On an unknown model id at cost time, log a warning and record the usage row under the
  raw model id so it stays visible in the dashboard instead of vanishing as `$0`.
- Validate `Version.model` against the catalog at version save; warn (not block) in the
  editor for ids outside it, since custom models stay allowed.

**Done when**: an `xai/grok-imagine-*` generation records a nonzero cost, an unknown model
id produces a logged warning and a visible usage row, and tests cover both.

## M2 — Contract & security test hardening

**Why**: the secret-protection contract is composed in `agentUseCases`/`mcpUseCases`
(mask on read, masked-update preserves the stored secret, SSRF re-check at dispatch) but
has zero tests — a one-line regression would expose stored secrets to any signed-in user
unnoticed. Repository item mapping is CI-untested, so attribute drift silently drops
secrets (`headers ?? {}`). `resolveVersion`'s published→latest fallback can silently run
the wrong version. `versionName` is the only name without slug validation and collides
with the `published` sentinel.

**Scope**

- Use-case tests: list/get/create/update never leak `enc:v1:` ciphertext; update with a
  masked header preserves the stored secret; dispatch to an SSRF-rejected URL returns
  `{ ok: false }`.
- Repository round-trip tests via the existing fake doc-client pattern: externalAgent/mcp
  `headers`, chat message tool fields, `toUsageRow` + the two-step ADD.
- `resolveVersion` fallback ordering; `sendMessage` validation branches; non-owner 403 and
  missing 404 for `updateVersion`/`deleteVersion` (their tested siblings already have both).
- Map `ConditionalCheckFailedException` in `projectRepository.create` to `ConflictError`
  (today a create race returns a generic 500 instead of 409).
- Enforce `/^[a-z0-9-]+$/` on `versionName` and reject the reserved name `published`.

**Done when**: the scenarios above run in CI and the two validation fixes reject bad input
at the boundary.

## M3 — PII filtering: wire it or remove it

**Why**: `piiFiltering` exists in the version schema, UI, and domain type, but
`toEngineParameters` never maps it — the toggle does nothing while appearing functional.
Shipping a setting that silently no-ops is worse than not having it.

**Scope (wire)**

- Regex-based detection for email and phone number (no third-party dependency).
- Format-preserving random substitution before the LLM call; restore originals in the
  response (the model never sees real PII).
- Streaming-safe restore via token-boundary buffering.

**Fallback**: if filtering is descoped, delete the dead parameter end-to-end instead.

**Done when**: with the toggle on, a prompt containing an email/phone reaches the channel
masked and the final response shows the original values, in both streaming and
non-streaming paths; with the toggle off, behavior is byte-identical to today.

## M4 — Wire the trace system

**Why**: `traceRepository`, the `Trace` entity, `keys.trace`, and its GSI partition are
already defined but referenced nowhere — agent runs currently leave no execution record,
making multi-turn debugging guesswork.

**Scope**

- Record a trace per engine run (spans per turn: model call, tool call, subagent transfer).
- Link subagent runs to the parent trace (`subagentTraceId` on the parent span).
- Sampling: agent runs always traced; plain predict/chat at a configurable sample rate.
- Trace list + detail API and console screens per project.
- Cap stored span input/output sizes; compact long message arrays instead of hard truncation.
- Promote the trace port + row types from the infrastructure adapter into
  `src/domain/trace/` so the repository follows the same dependency rule as the other
  entities.

**Done when**: running a published agent produces a persisted trace whose spans (including
a subagent transfer) are viewable in the console; unit tests cover recording and sampling.

## M5 — Cost threshold alert + block

**Why**: daily per-project-per-model cost is already aggregated in DynamoDB, but nothing
acts on it — a runaway loop or bulk caller can spend without bound. The only guard today
is the engine turn limit. Depends on M1: thresholds are only as trustworthy as the ledger.

**Scope**

- Per-project settings: `alertThresholdUsd` and `blockThresholdUsd` (both optional).
- Alert: when daily (UTC) cost crosses the alert threshold, send a Slack notification once
  per day (conditional-write dedupe).
- Block: when daily cost crosses the block threshold, reject further runs for that day with
  a dedicated HTTP status; pre-check at run entry, post-check after usage flush.
- All guard lookups/writes fail open — a guard failure must never block or break a run.

**Done when**: a project over its block threshold gets rejected at every run entry point
(predict, chat/completions, agent, chat, Slack, A2A) for the rest of the UTC day, the alert
fires exactly once per day, and tests cover threshold crossing, dedupe, and fail-open.

## M6 — Publish history + version snapshot diff

**Why**: publish only moves a pointer; there is no record of who published what, when, or
what changed — "why did responses change" is unanswerable.

**Scope**

- Append-only publish history row per publish: version snapshot, publisher, timestamp,
  optional description.
- History timeline on the project screen with a field-level diff between adjacent
  snapshots (rule-based per parameter, not raw JSON).

**Done when**: publishing twice shows a two-entry timeline whose diff lists exactly the
changed fields; history rows are immutable.

## M7 — Evaluation (test sets × version comparison)

**Why**: there is no way to check that a prompt change didn't regress — the core
differentiator of a prompt-management platform.

**Scope**

- Per-project test sets (variable bindings per case), CSV import/export.
- Side-by-side run of selected versions over the set; per-cell and per-version rerun.
- Cache outputs keyed by case identity + version config fingerprint; mark stale cells
  when config changes instead of silently reusing them.
- "Add test case" shortcut from the playground's current inputs.

**Done when**: two versions can be run over a saved set and compared column-by-column,
and editing a version marks its cached cells stale.

## M8 — Retry layer with backoff

**Why**: the only resilience today is a single pre-first-chunk fallback. A transient 429
goes straight to the fallback model (or the user) without a retry.

**Scope**

- Channel-level retry (max ~3) with exponential backoff and jitter for retryable errors
  (408/429/5xx), before fallback engages.
- Keep the layers distinct: retry handles transient same-model errors; fallback handles
  model-level failure. Preserve current semantics — no retry/fallback after the first
  streamed chunk.
- Audit fallback cost attribution while in this code: usage must record the model that
  actually served the request, priced with that model's rates.

**Done when**: a channel that 429s twice then succeeds completes without engaging
fallback; tests cover backoff classification and the fallback cost attribution path.

## M9 — Version tags (aliases)

**Why**: `published` is the only symbolic reference; staging/experiment flows need named
pointers without copying version numbers around.

**Scope**

- Project-level tag map (`tag → version`), replaced whole via a single desired-state PUT.
- Read/run endpoints accept tags wherever a version name is accepted; mutation endpoints
  accept real version names only (asymmetry is deliberate — prevents editing "whatever
  the tag points at").
- Resolve tags at request time; record the resolved real version in usage/traces.

**Done when**: a run addressed by tag executes the tagged version and its usage/trace rows
carry the real version name; mutating by tag is rejected.

## M10 — Pseudo-model usage rows for non-token billing

**Why**: costs that are not LLM tokens (web search, grounding, retrieval — as they get
added) need a home. Recording them as synthetic model rows (e.g. `search/web_search`)
reuses the whole aggregation pipeline and dashboard with zero schema change.

**Scope**

- Convention: synthetic model id per billing source, `calls` counted per billed unit,
  cost from a per-unit rate; do not inflate real-model call counts.
- Distinguish "tool registered" from "tool actually invoked" — record only on use.

**Done when**: the first non-token cost source lands as a pseudo-model row and appears in
the dashboard grouped like any model, covered by a unit test.

## Backlog (invest when demand is real)

- **Convention convergence** — behavior-preserving refactors, best batched when a slice is
  already being touched: converge the four DI styles on the factory pattern
  (`createXUseCases`); collapse the parallel `ChatError` classes onto the shared
  `AppError` hierarchy (as `project/errors.ts` already does); make UI api modules
  re-export domain types instead of redefining them (the UI `Skill` type has already
  drifted — it lacks `source`); derive the settings repository `FIELDS` list from
  `FIELD_SPECS` so field additions can't silently miss persistence; model `ChatMessage`
  as a discriminated union on `role`; promote the Slack-event port into `src/domain`.
- **Scheduled runs** — natural-language schedule → RRULE, CAS-claimed occurrences, Slack
  delivery. Needs a runner process; heavy for a single Next.js deployment.
- **Batch processing** — requires the full lease/fencing/heartbeat/checkpoint stack.
- **AI assistant sidebar** — prompt-improvement suggestions rendered as applyable diffs.
- **Artifacts gallery** — persist and share chat-generated HTML reports.
- **RAG / file search** — delegate chunking/indexing to a managed search service.
- **A2A task store persistence** — the in-memory store assumes a single instance; move to
  DynamoDB before scaling horizontally.
