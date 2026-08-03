# Configuration

Every value Agent Studio reads from its environment, plus the limits that are fixed in code
and therefore *not* configurable. `.env.example` is the copyable template; this document is
the reference that explains what each value does and what happens when it is wrong.

Related: [OPERATIONS.md](OPERATIONS.md) for what to set on a deployed instance,
[DEVELOPMENT.md](DEVELOPMENT.md) for a local `.env.local`, [SECURITY.md](SECURITY.md) for the
values that are credentials.

## Resolution order

A setting can come from four places, and the first one that has it wins:

```
workspace override   →   DynamoDB SETTINGS#app override   →   environment variable   →   default
```

The workspace layer applies only inside a workspace and only to the keys a workspace may
decide (`TENANT_OVERRIDABLE_KEYS` in `src/domain/settings/types.ts`): its LLM channel and
credentials, its skill and tool repositories, and `UNKNOWN_MODEL_POLICY`. Everything else is
the deployment's — infrastructure the process is bound to, the sign-in domain gate, the
inbound A2A key that gates an endpoint rather than a tenant, and `ADMIN_EMAILS`, which inside
a workspace is answered by membership instead. The resolution reads *through* that list rather
than trusting the stored row, so a key that was never meant to be a workspace's cannot become
one by being written, and narrowing the list takes effect on the next read.

Fallback is key by key, not row by row: a workspace deciding its LLM channel keeps the
deployment's answer for its skills repository.

The override layer is the admin-only `/settings` page. Only the keys marked **runtime** in
the tables below can be overridden there; everything else is env-only, because it is needed
before the settings row can be read (`AES_ENCRYPTION_KEY` decrypts that row) or because it
is infrastructure the process is already bound to (`STAGE`, DynamoDB, Better Auth).

Reads go through `src/lib/runtime-settings.ts`, never `process.env` directly at dispatch —
otherwise an override would apply on the settings page and nowhere else. Both override layers
are cached in memory for `SETTINGS_CACHE_TTL_MS` (the workspace one per workspace) and the
cache is invalidated on write, but **the invalidation is process-local**: on a multi-instance deployment the TTL is how long a
demoted admin or a rotated A2A key keeps working on the instances that did not serve the
write. That is why the default is 5 seconds rather than a minute.

## Boot-time validation

`src/instrumentation.ts` runs two checks before the server accepts connections, so a
misconfiguration fails at startup rather than as a 500 on the first request that needs the
value.

| Check | Rule |
|---|---|
| `assertRequiredConfig` | `LLM_BASE_URL`, `LLM_API_KEY` and `AES_ENCRYPTION_KEY` must be set, in every stage. |
| `assertAccessControlConfig` | `STAGE=alpha` or `prod` additionally requires `ADMIN_EMAILS` **and** `ALLOWED_EMAIL_DOMAINS`. |

The second check exists because both lists are fail-open when empty — an unset
`ALLOWED_EMAIL_DOMAINS` lets any Google account sign in, and an unset `ADMIN_EMAILS` makes
every signed-in user an admin over the shared registries. That is the right default for
zero-config local development and the wrong one for a deployment, so `local` keeps it and
the deployed stages refuse to boot without it.

Google OAuth credentials are deliberately *not* boot-required: the local dev-session flow
(`scripts/dev-session.ts`) bypasses OAuth entirely.

## Core

| Variable | Default | Runtime | Notes |
|---|---|---|---|
| `STAGE` | `local` | — | `local` \| `alpha` \| `prod`. Any other value throws at boot. Gates the access-control check above. |
| `AWS_REGION` | `ap-northeast-2` | — | Region for every AWS client. DynamoDB Local namespaces tables by access key **and** region, so the app and `pnpm init-local-table` must agree. |
| `DYNAMODB_TABLE_NAME` | `agent-studio` | — | The single table. On a shared local DynamoDB this — not the port — is what keeps projects apart. |
| `DYNAMODB_ENDPOINT` | unset | — | DynamoDB Local only. **Must be empty in alpha/prod**; a leftover value points the app at a localhost that is not there. |
| `AES_ENCRYPTION_KEY` | — (required) | — | 32-byte base64. Encrypts every stored secret. See [SECURITY.md](SECURITY.md#secrets-at-rest). |
| `S3_BUCKET_NAME` | unset | — | Bucket for chat images. Objects are written with no ACL and read through presigned URLs, so the bucket must **not** be public-read; the app never deletes one, so it also needs a lifecycle rule ([OPERATIONS.md](OPERATIONS.md#row-retention)). Unset disables persistence — chat images then render only during the live stream. |
| `PUBLIC_BASE_URL` | `BETTER_AUTH_URL`, else the request origin, else `http://localhost:3000` | **runtime** | Scheme + host used to build outward-facing URLs (A2A Agent Cards, Slack manifests, the OAuth callback). Behind a reverse proxy the request URL reflects the bind address, so this has to come from configuration. The request-origin step applies only where a request is at hand — the A2A Agent Card path has none, so with both variables unset a card advertises `localhost`. |

## Authentication and access control

| Variable | Default | Runtime | Notes |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | — | — | Session signing secret (`npx @better-auth/cli secret`). |
| `BETTER_AUTH_URL` | — | — | Base URL Better Auth builds its callback against. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | — | Required for real login only. |
| `ALLOWED_EMAIL_DOMAINS` | empty | **runtime** | Comma-separated domains allowed to sign in. Empty = any domain. |
| `TRUSTED_PROXY_CIDRS` | empty | — | Comma-separated IPs/CIDR ranges of the reverse proxies in front of this deployment (e.g. the VPC CIDR when ALB + Istio both append to `X-Forwarded-For`). Better Auth strips these hops from the right of the chain to resolve the client IP its rate limiting keys on; empty trusts only a single-value header, so behind two proxies every request falls into one shared bucket. |
| `ADMIN_EMAILS` | empty | **runtime** | Comma-separated. Grants registry/settings mutation, and grants write access to projects owned by someone else. Empty means *no restriction* for the first and *nobody* for the second — the two questions are answered by different predicates on purpose ([SECURITY.md](SECURITY.md#authorization-model)). |

## LLM channels

All traffic speaks the OpenAI Chat Completions protocol. Model ids are `provider/model`.

| Variable | Default | Runtime | Notes |
|---|---|---|---|
| `LLM_BASE_URL` | — (required) | **runtime** | The default channel — a router such as OpenRouter or LiteLLM. Every model id goes here unless a provider channel claims it. |
| `LLM_API_KEY` | — (required) | **runtime** | Credential for that channel. |
| `LLM_PROVIDER_<NAME>_BASE_URL` | unset | **runtime** | Registers a per-provider channel. `<NAME>` is the model id's provider prefix, upper-cased. The registry's providers are `OPENAI`, `ANTHROPIC`, `GOOGLE`, `XAI`; the env parser accepts any `[A-Z0-9_]+` name, but a channel outside that list can never match a model id — the `/settings` override path refuses one outright. |
| `LLM_PROVIDER_<NAME>_API_KEY` | unset | **runtime** | Credential for that channel. |
| `LLM_PROVIDER_<NAME>_KEEP_MODEL_PREFIX` | `false` | **runtime** | Provider channels receive the bare model name (the `provider/` prefix stripped). Set this when the channel is itself a router that expects full ids. |

When any provider channel is configured, `GET /api/models` lists only those providers'
models; with none configured it lists the whole registry.

A stored `llmProviders` override on `/settings` **replaces the entire `LLM_PROVIDER_*` env
set** rather than merging with it — a partial merge would make "remove this provider" an
unexpressible edit.

### Model registry and `wireId`

The selectable models — pricing, context window, capability flags — live in
`src/domain/llm/models.ts` and are hand-maintained, because those numbers exist only in each
provider's documentation.

Registry ids follow the router convention (`anthropic/claude-opus-4.8`), which is also what
stored project versions hold. When a provider's own API spells the same model differently —
Anthropic serves `claude-opus-4-8` and 404s on the dotted form — set `wireId` on that entry;
it is what gets sent once a provider-direct channel strips the prefix. Renaming the entry
instead would orphan every stored version that referenced the old id.

**A model missing from the registry still runs, but its usage is priced at $0** — so the gap
is invisible in the cost dashboard it corrupts. Each miss logs `[cost] unknown model id`
once and increments `agent_studio_unknown_model_calls_total`; alert on a non-zero rate
rather than waiting to notice the cost. A deployment that *bills* on those numbers can set
[`UNKNOWN_MODEL_POLICY=refuse`](#execution-limits) and have such a run refused before dispatch
instead. `pnpm check-models` compares the registry against what the configured channels
actually serve — see [DEVELOPMENT.md](DEVELOPMENT.md#scripts).

## Execution limits

| Variable | Default | Runtime | Notes |
|---|---|---|---|
| `MAX_RUN_DURATION_MS` | `600000` (10 min) | — | Wall-clock cap on a single run, every entry point. A hung provider or tool call cannot run — or bill — unbounded. An invalid value is ignored with a warning. The Slack path additionally applies the fixed 3-minute interactive deadline (below), which can only shorten a run. Two derived values move with this one: the run-slot lease (this value plus 60s) and the MCP OAuth token refresh margin (this value plus 5 min). |
| `MAX_CONCURRENT_RUNS_PER_ACTOR` | `10` | — | Runs one caller may have in flight. `0` disables the limit. |
| `MAX_CONCURRENT_RUNS_A2A` | `50` | — | Separate ceiling for inbound A2A, because its actor id is a constant: the inbound key is shared, so one identity stands for every machine caller and the per-caller limit would otherwise cap the whole A2A surface. |
| `UNKNOWN_MODEL_POLICY` | `allow` | **runtime** | `allow` \| `refuse`. On `refuse`, a run whose model **or fallback** is missing from `src/domain/llm/models.ts` is rejected before dispatch with a 400 — the alternative is a run booked at $0. Anything other than the exact string `refuse` reads as `allow`, including a typo: refusing on an unrecognised value would turn a misspelled setting into an outage. Version *writes* are unaffected; what this gates is execution. |
| `SCHEDULE_SCAN_TOKEN` | unset | — | What the schedule ticker presents to `POST /api/triggers/scan` (`X-Scan-Token`). Unset means this deployment has no ticker: schedule triggers never fire and the endpoint answers 503 — off rather than open. |

Invalid values (non-integer, negative) degrade to the default with a warning rather than to
`0` — `Number("abc") || 0` would read as "limit off", which is the opposite of what a typo
should mean.

## MCP

| Variable | Default | Runtime | Notes |
|---|---|---|---|
| `MCP_DISCOVERY_CACHE_TTL_MS` | `60000` | — | How long a bound server's tool list is reused, keyed by `url + headers`. A warm entry also lets the session handshake lazily, so a turn that calls no tool makes no MCP request at all. `0` disables caching outright, and no server hint can switch it back on. |
| `MCP_MAX_SERVER_TTL_MS` | `300000` (5 min) | — | Ceiling on the `ttlMs` a server may request on `tools/list` (SEP-2549). `0` ignores server hints entirely and returns every entry to the local TTL. |
| `MCP_INTERNAL_HOST_SUFFIXES` | empty | — | Comma-separated DNS suffixes whose hosts an MCP entry may use despite resolving to a private address — typically `<namespace>.svc.cluster.local`. Empty leaves the SSRF guard exactly as it was. See [SECURITY.md](SECURITY.md#declared-internal-hosts). |
| `MANAGED_MCP_INSTANCE_ID` | unset | — | The host managed MCP containers are started on, through SSM Run Command. |
| `MANAGED_MCP_REGISTRY` | unset | — | The registry `docker login` authenticates against, so this account's own images pull without a credential being typed. Images from any other registry the host can pull from are allowed; the login is simply skipped for them. |
| `MANAGED_MCP_NETWORK_CONTAINER` | `agent-studio` | — | The container managed workloads share a network namespace with — this app's own. Every container has its own `127.0.0.1`, so a loopback address only means anything when both ends are in the same namespace. |

`MANAGED_MCP_INSTANCE_ID` and `MANAGED_MCP_REGISTRY` unset means the managed-MCP routes
answer `503` rather than half-enabling the feature.

**Why the discovery TTL has two knobs.** An entry's lifetime answers two questions with one
number. The server's hint answers the first — how fresh its catalogue is — and it knows that
better than this app does. But the same number bounds the second: invalidation on a registry
edit is process-local, so it is also how long that edit goes unseen on the *other* instances.
That second answer belongs to the deployment, not to the server, and without a ceiling a
server asking for an hour would decide it for the whole fleet. Raising
`MCP_DISCOVERY_CACHE_TTL_MS` instead would also stop unhinted servers being re-read, which
is the opposite trade — hence a separate knob. Single-instance deployments can raise
`MCP_MAX_SERVER_TTL_MS` freely; multi-instance ones should keep it near the staleness they
are willing to wear.

Failed discoveries are cached too, for the smaller of `MCP_DISCOVERY_CACHE_TTL_MS` and 30s.
Without it, a server
that is down — or a connection whose token was revoked — re-pays a failing handshake before
the first token of every message. The window is short because a stale failure hides a
recovery while a stale success only serves a slightly old tool list.

## Source repositories

| Variable | Default | Runtime | Notes |
|---|---|---|---|
| `SKILLS_REPO` | unset | **runtime** | `owner/repo`. Layout is `skills/<name>/SKILL.md`; the parent directory name is the skill slug. |
| `SKILLS_REPO_BRANCH` | `main` | **runtime** | |
| `TOOLS_REPO` | unset | **runtime** | `owner/repo`. Layout is `tools/<name>/TOOL.md`; the parent directory name is the registry entry name. Frontmatter carries `url` and `description`; the body becomes the entry's operator notes. An existing entry is reported, never written, until the caller names it for overwrite — and an overwrite replaces only those three fields, so headers and OAuth stay put. |
| `TOOLS_REPO_BRANCH` | `main` | **runtime** | |
| `GITHUB_TOKEN` | unset | **runtime** | Needs contents read access. Shared by both syncs. |

Both syncs work the same way: **they import what is missing and report the rest.** A name the
registry already holds is left alone and reported with the fields the document would replace;
a name a previous sync created and the repository no longer carries is reported as orphaned.
Neither is acted on until a person picks it in the console — the stored version may be a
deliberate edit, and an MCP entry may hold credentials. When an overwrite does happen it
replaces only what the document owns: encrypted headers, a discovered OAuth block and a
managed entry's provisioned address are never touched.

A cluster-internal URL is registerable this way only if its host is covered by
`MCP_INTERNAL_HOST_SUFFIXES` — the sync faces the same outbound guard a typed URL does, and a
refusal is reported as a skip rather than failing the whole run.

## Slack

| Variable | Default | Runtime | Notes |
|---|---|---|---|
| `SLACK_LOADING_INDICATOR` | `:hourglass_flowing_sand:` | — | Appended to a Slack reply while it is still being written, then dropped by the final edit. **Only on the edit-in-place fallback** — a streamed reply is marked as still arriving by Slack itself. A workspace with its own spinner emoji names it here; the default is built in, because a custom name a workspace has not defined renders as literal text. |

## A2A

| Variable | Default | Runtime | Notes |
|---|---|---|---|
| `A2A_API_KEY` | unset | **runtime** | Shared key for inbound A2A JSON-RPC (`X-A2A-Key`). Unset disables the `/api/a2a` endpoints entirely. Issue one from `/settings` rather than inventing it. |

Agent Card URLs are built from `PUBLIC_BASE_URL`.

## Observability and retention

| Variable | Default | Runtime | Notes |
|---|---|---|---|
| `TRACE_SAMPLE_RATE` | `0.1` | — | `0`–`1`, applied to top-level predict and image runs. Agent runs are always traced. Unlike the limits above, an out-of-range value clamps into the range silently; only a non-numeric one falls back to the default. |
| `SETTINGS_CACHE_TTL_MS` | `5000` | — | In-memory TTL for the settings row. Bounds cross-instance staleness of every runtime override — see [Resolution order](#resolution-order). Floors at `1`, so `0` degrades to the default rather than disabling the cache. |
| `TRACE_RETENTION_DAYS` | `30` | — | DynamoDB TTL on the row's `expiresAt`. |
| `USAGE_RETENTION_DAYS` | `400` | — | Kept well beyond the dashboard's 184-day query window. |
| `CHAT_RETENTION_DAYS` | `180` | — | Measured from the chat's last activity. |
| `TRIGGER_RUN_RETENTION_DAYS` | `30` | — | Delivery history is an operational log, not a record to keep. |
| `A2A_TASK_RETENTION_DAYS` | `1` | — | Ephemeral job state, kept just long enough for `tasks/get`/`tasks/cancel` after `message/send`. |
| `AUDIT_RETENTION_DAYS` | `365` | — | Audit rows — who revealed a credential, who overrode an ownership check. The longest window here, because the question they answer is asked long after the fact. |

Retention values must be positive numbers; anything else falls back to the default. TTL has
to be **enabled on the `expiresAt` attribute of the production table** — see
[OPERATIONS.md](OPERATIONS.md#row-retention).

## Local scripts only

| Variable | Default | Notes |
|---|---|---|
| `MOCK_LLM_PORT` | `8002` | `scripts/mock-llm.ts` listen port. |
| `INTEGRATION_MOCK_PORT` | `8002` | Mock LLM port used by `scripts/integration-check.ts`. |

## Limits fixed in code

These bound a run and are **not** environment-configurable. Each has a single owning file,
pinned by `tests/architecture.test.ts` where a second copy would drift.

| Limit | Value | Owner |
|---|---|---|
| Turns per agent run (version `maxTurn` default) | `50` | `src/application/llm/engine.ts` |
| Agents one `dispatch_agents` call may run | `4` | `src/application/llm/engine.ts` |
| Tool-result text per turn | `200,000` chars | `src/application/llm/engine.ts` |
| Transfer transcript carried to a subagent | `8,000` chars | `src/application/llm/engine.ts` |
| Subagent nesting depth | `5` | `src/application/execution/subagentRunner.ts` |
| MCP tools declared per run | `120` | `src/application/execution/mcpTools.ts` |
| A single MCP tool result | `100,000` chars | `src/infrastructure/mcp/toolManager.ts` |
| An MCP server's HTTP response | `2MB` | `src/infrastructure/mcp/session.ts` |
| MCP OAuth metadata / token response | `256KB` each | `src/infrastructure/mcp/oauthMetadata.ts`, `oauthClient.ts` |
| MCP discovery cache entries | `200` | `src/infrastructure/mcp/discoveryCache.ts` |
| A remote agent's (A2A / external) response | `2MB` | `src/infrastructure/agent/dispatcher.ts`, `agentClient.ts` |
| Concurrent MCP calls per model response | `5` | `src/application/llm/engine.ts` |
| Interactive (Slack) run deadline | `3` min | `src/shared/runDeadline.ts` |
| Images per turn / bytes each | `4` / `5MB` | `src/domain/llm/imageLimits.ts` |
| Documents per turn / bytes each | `4` / `10MB` | `src/domain/llm/documentLimits.ts` |
| Extracted text kept, per document / per turn | `20,000` / `40,000` chars | `src/domain/llm/documentLimits.ts` |
| Chat request body (derived from the attachment caps) | ~`84MB` | `src/app/api/_lib/body.ts` |
| Transfer transcript line kept when a turn overflows | `500` chars minimum | `src/application/llm/engine.ts` |
| Context-budget estimate (ASCII / other / image part / headroom) | `3` chars per token / `1.5` tokens per char / `2,500` tokens / `2,000` tokens | `src/application/llm/contextBudget.ts` |
| Tool result kept when the run's context budget cuts it | `500` chars minimum | `src/application/llm/engine.ts` |
| Chat history replayed into context | `200` messages / `200,000` chars | `src/application/chat/messageMapping.ts` |
| Chat tool traffic replayed into context | `3` turns / `20,000` chars | `src/application/chat/messageMapping.ts` |
| Inbound webhook trigger / Slack event body | `1MB` each | `src/app/api/triggers/[project]/[trigger]/route.ts`, `src/app/api/slack/events/_lib/handleEventRequest.ts` |
| Slack thread turns used as context | `50` | `src/application/slack/handleSlackEvent.ts` |
| Slack thread title / history image lookback | `60` chars / `10` messages | `src/application/slack/handleSlackEvent.ts` |
| Slack suggested prompts per project | `4` | `src/domain/slack/types.ts` |
| Slack prompt title / message / agent description | `80` / `500` / `300` chars | `src/domain/slack/types.ts` |
| Slack reply write cadence (stream / edit) | `1s` / `3s` | `src/application/slack/replyStream.ts` |
| Slack status refresh (Slack expires it at `2m`) | `45s` | `src/application/slack/replyStream.ts` |
| Slack profile cache (success / failure / entries) | `1h` / `1m` / `2000` | `src/infrastructure/slack/profileCache.ts` |
| Usage summary query range | `184` days | `src/app/api/usages/summary/validation.ts` |
| Schedule catch-up window (bounds what an outage can fire at once) | `10` min | `src/application/trigger/scanSchedules.ts` |
| Schedule firings one scan tick drives concurrently | `8` | `src/application/trigger/scanSchedules.ts` |
| Schedule repair sweep (lost-run recovery) | every `5` min, `50` rows | `src/application/trigger/scanSchedules.ts` |

### The run-wide context budget

The per-item limits above say nothing about their sum, so
`src/application/llm/contextBudget.ts` owns one more bound: an agent run's total context,
derived from the model's `contextWindow` (the **minimum** of primary and fallback when a
fallback is configured) minus the output reserve and a protocol headroom. The reserve is the
version's `maxTokens` when set; when it is not, no `max_tokens` goes on the wire and
whichever model serves the call may generate up to its own registry maximum, so the reserve
is the **larger** of the two models'. The input, the tool definitions, every turn's output,
tool results and transferred answers are charged against it — truncation markers, wrappers
and omission strings included; a marker is reserved inside the cut, never appended on top of
one. What no longer fits is truncated with a marker the model can read and reported once as
a `warning` chunk — instead of overflowing into a provider `400` mid-run.

Tokens are estimated, conservatively, from characters (per class: ASCII at 3 chars/token,
everything else at 1.5 tokens/char; an image part at a flat 2,500 tokens) — exact counts
would need each provider's tokenizer. A model missing from the registry gets **no budget**:
there is no window to derive one from, so such a run stays unbudgeted exactly as every run
was before the budget existed — as does a version whose `maxTokens` leaves the window no
capacity at all, because a zero budget would refuse every tool call while blaming a budget
the run never got to fill. Single-shot (`llm`) runs are also unbudgeted — nothing
accumulates in one call, and the input is the caller's own.
