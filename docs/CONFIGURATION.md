# Configuration

Every value Agent Studio reads from its environment, plus the limits that are fixed in code
and therefore *not* configurable. `.env.example` is the copyable template; this document is
the reference that explains what each value does and what happens when it is wrong.

Related: [OPERATIONS.md](OPERATIONS.md) for what to set on a deployed instance,
[DEVELOPMENT.md](DEVELOPMENT.md) for a local `.env.local`, [SECURITY.md](SECURITY.md) for the
values that are credentials.

## Resolution order

A setting can come from three places, and the first one that has it wins:

```
DynamoDB SETTINGS#app override   →   environment variable   →   built-in default
```

The override layer is the admin-only `/settings` page. Only the keys marked **runtime** in
the tables below can be overridden there; everything else is env-only, because it is needed
before the settings row can be read (`AES_ENCRYPTION_KEY` decrypts that row) or because it
is infrastructure the process is already bound to (`STAGE`, DynamoDB, Better Auth).

Reads go through `src/lib/runtime-settings.ts`, never `process.env` directly at dispatch —
otherwise an override would apply on the settings page and nowhere else. Values are cached
in memory for `SETTINGS_CACHE_TTL_MS` and the cache is invalidated on write, but **the
invalidation is process-local**: on a multi-instance deployment the TTL is how long a
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
| `S3_BUCKET_NAME` | unset | — | Public-read bucket for generated images. Unset disables persistence — chat images then render only during the live stream. |
| `PUBLIC_BASE_URL` | `BETTER_AUTH_URL`, else the request origin | **runtime** | Scheme + host used to build outward-facing URLs (A2A Agent Cards, Slack manifests, the OAuth callback). Behind a reverse proxy the request URL reflects the bind address, so this has to come from configuration. |

## Authentication and access control

| Variable | Default | Runtime | Notes |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | — | — | Session signing secret (`npx @better-auth/cli secret`). |
| `BETTER_AUTH_URL` | — | — | Base URL Better Auth builds its callback against. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | — | Required for real login only. |
| `ALLOWED_EMAIL_DOMAINS` | empty | **runtime** | Comma-separated domains allowed to sign in. Empty = any domain. |
| `ADMIN_EMAILS` | empty | **runtime** | Comma-separated. Grants registry/settings mutation, and grants write access to projects owned by someone else. Empty means *no restriction* for the first and *nobody* for the second — the two questions are answered by different predicates on purpose ([SECURITY.md](SECURITY.md#authorization-model)). |

## LLM channels

All traffic speaks the OpenAI Chat Completions protocol. Model ids are `provider/model`.

| Variable | Default | Runtime | Notes |
|---|---|---|---|
| `LLM_BASE_URL` | — (required) | **runtime** | The default channel — a router such as OpenRouter or LiteLLM. Every model id goes here unless a provider channel claims it. |
| `LLM_API_KEY` | — (required) | **runtime** | Credential for that channel. |
| `LLM_PROVIDER_<NAME>_BASE_URL` | unset | **runtime** | Registers a per-provider channel. `<NAME>` is the model id's provider prefix, upper-cased: `OPENAI`, `ANTHROPIC`, `GOOGLE`, `XAI`. |
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
rather than waiting to notice the cost. `pnpm check-models` compares the registry against
what the configured channels actually serve — see [DEVELOPMENT.md](DEVELOPMENT.md#scripts).

## Execution limits

| Variable | Default | Runtime | Notes |
|---|---|---|---|
| `MAX_RUN_DURATION_MS` | `600000` (10 min) | — | Wall-clock cap on a single run, every entry point. A hung provider or tool call cannot run — or bill — unbounded. An invalid value is ignored with a warning. |
| `MAX_CONCURRENT_RUNS_PER_ACTOR` | `10` | — | Runs one caller may have in flight. `0` disables the limit. |
| `MAX_CONCURRENT_RUNS_A2A` | `50` | — | Separate ceiling for inbound A2A, because its actor id is a constant: the inbound key is shared, so one identity stands for every machine caller and the per-caller limit would otherwise cap the whole A2A surface. |

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

Failed discoveries are cached too, for at most 30s (not configurable). Without it, a server
that is down — or a connection whose token was revoked — re-pays a failing handshake before
the first token of every message. The window is short because a stale failure hides a
recovery while a stale success only serves a slightly old tool list.

## Skills repository

| Variable | Default | Runtime | Notes |
|---|---|---|---|
| `SKILLS_REPO` | unset | **runtime** | `owner/repo`. Layout is `skills/<name>/SKILL.md`; the parent directory name is the skill slug. |
| `SKILLS_REPO_BRANCH` | `main` | **runtime** | |
| `GITHUB_TOKEN` | unset | **runtime** | Needs contents read access. |

## A2A

| Variable | Default | Runtime | Notes |
|---|---|---|---|
| `A2A_API_KEY` | unset | **runtime** | Shared key for inbound A2A JSON-RPC (`X-A2A-Key`). Unset disables the `/api/a2a` endpoints entirely. Issue one from `/settings` rather than inventing it. |

Agent Card URLs are built from `PUBLIC_BASE_URL`.

## Observability and retention

| Variable | Default | Runtime | Notes |
|---|---|---|---|
| `TRACE_SAMPLE_RATE` | `0.1` | — | `0`–`1`, applied to non-agent predict runs. Agent runs are always traced. |
| `SETTINGS_CACHE_TTL_MS` | `5000` | — | In-memory TTL for the settings row. Bounds cross-instance staleness of every runtime override — see [Resolution order](#resolution-order). |
| `TRACE_RETENTION_DAYS` | `30` | — | DynamoDB TTL on the row's `expiresAt`. |
| `USAGE_RETENTION_DAYS` | `400` | — | Kept well beyond the dashboard's 184-day query window. |
| `CHAT_RETENTION_DAYS` | `180` | — | Measured from the chat's last activity. |
| `TRIGGER_RUN_RETENTION_DAYS` | `30` | — | Delivery history is an operational log, not a record to keep. |
| `A2A_TASK_RETENTION_DAYS` | `1` | — | Ephemeral job state, kept just long enough for `tasks/get`/`tasks/cancel` after `message/send`. |

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
| Concurrent MCP calls per model response | `5` | `src/application/llm/engine.ts` |
| Images per turn / bytes each | `4` / `5MB` | `src/domain/llm/imageLimits.ts` |
| Chat history replayed into context | `200` messages / `200,000` chars | `src/application/chat/messageMapping.ts` |
| Slack thread turns used as context | `50` | `src/application/slack/handleSlackEvent.ts` |
| Usage summary query range | `184` days | `src/app/api/usages/summary/validation.ts` |

There is deliberately **no run-wide context budget** yet: every limit above is per-item or
per-turn, so a long tool-heavy run can still overflow a small `contextWindow` and surface as
a provider `400`. That gap is tracked as the `context-budget` milestone in
[MILESTONES.md](MILESTONES.md).
