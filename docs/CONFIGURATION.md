# Configuration

Every value AgentDure reads from its environment, plus the limits that are fixed in code
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

An override and an environment variable answer *"is it set?"* the same way: a value that is
empty or only whitespace counts as **unset** and falls through to the next layer instead of
becoming the effective one. Saving a blank field on `/settings` removes the override, and
`A2A_API_KEY=" "` is not a key — including at boot, where it reports as missing. This
matters most for a secret mounted from a file, which arrives with a trailing newline a
header cannot carry. `src/shared/env.ts` owns the rule, and the value it returns is trimmed.
`STAGE`, `DYNAMODB_TABLE_NAME` and `AWS_REGION` are the exceptions — they take an empty
value literally, and for `STAGE` that is deliberate: an empty value throws, where falling
back to `local` would skip `assertAccessControlConfig` on a deployed stage.

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
| `DYNAMODB_TABLE_NAME` | `agentdure` | — | The single table. On a shared local DynamoDB this — not the port — is what keeps projects apart. |
| `DYNAMODB_ENDPOINT` | unset | — | DynamoDB Local only. **Must be empty in alpha/prod**; a leftover value points the app at a localhost that is not there. |
| `AES_ENCRYPTION_KEY` | — (required) | — | 32-byte base64. Encrypts every stored secret. See [SECURITY.md](SECURITY.md#secrets-at-rest). |
| `S3_BUCKET_NAME` | unset | — | Bucket for what runs produce — generated images and stored documents, under `artifacts/<kind>/`. **Private**: a row stores the object key and every read URL is pre-signed with the role's own credentials, so the grant must cover **`artifacts/*`** (not just the legacy `images/*`) with all of `s3:PutObject`, `s3:GetObject` and `s3:DeleteObject` — see the [deployment checklist](OPERATIONS.md#operational-checklist-for-a-new-deployment), where both halves of that have gone wrong. Unset disables persistence entirely: runs still draw, the bytes reach the surface and stop, and the artifacts gallery answers 404. |
| `VECTOR_BUCKET` | unset | — | S3 Vectors bucket holding the capability catalog. Unset means the deployment has no catalog: `POST /api/catalog/reindex` answers 503 and a run offers exactly what its version bound. That 503 has two causes and the token check runs first, so an unset `SCHEDULE_SCAN_TOKEN` produces the same status with a different message. The role needs `s3vectors:PutVectors`, `QueryVectors`, `GetVectors`, `ListVectors` and `DeleteVectors` on the index — `GetVectors` because a search asks for each match's metadata, which the query returns only under that action. A role missing it **reindexes successfully and then fails every lookup**: the writes go through, and each run logs `capability discovery failed; running with bindings only` while the console shows a healthy catalog. |
| `CATALOG_INDEX` | `capabilities` | — | Index within that bucket. Its dimension must match `EMBEDDING_MODEL`'s and its metric must be cosine. |
| `EMBEDDING_PROVIDER` | `openai` | — | `cohere` \| `bedrock` \| `openai`. The first two are Bedrock and need no credentials — the pod role carries `bedrock:InvokeModel` — while `openai` reuses `LLM_BASE_URL`/`LLM_API_KEY` and requires that endpoint to serve `/embeddings`. Anything unrecognised reads as `openai`. **The demo cluster runs `cohere`**; see the table below. |
| `EMBEDDING_MODEL` | per provider: `global.cohere.embed-v4:0`, `amazon.titan-embed-text-v2:0`, `text-embedding-3-small` | — | Changing it means **rebuilding the index** — vectors from two models are not comparable, and nothing in a mixed index reports that; the scores are simply wrong. Cohere v4 is reached through its **inference profile**; the bare model id refuses on-demand invocation outright. |
| `EMBEDDING_DIM` | `1024` | — | The width the index was created at, asked for on every path. Cohere v4, Titan v2 and OpenAI's v3 models each serve several widths, and none of their defaults is 1024 — `text-embedding-3-small` is natively 1536 — so a provider left to its default answers with vectors the index rejects, and the catalog stays empty with nothing but a background log line to say why. |
| `CATALOG_MIN_SCORE` | `0.25` | — | Relevance floor, in `(0, 1]`. Belongs to the **embedding model**, not to the search — re-measure it whenever `EMBEDDING_MODEL` changes, or the catalog either answers everything or nothing. See the table below. Like `TRACE_SAMPLE_RATE` it **clamps** into `0`–`1` with a warning rather than falling back; a non-numeric value takes the default. It is only half the cut — a per-query ratio against that query's own best score is the other half, and the higher of the two wins — so a value clamped to `0` does not admit everything, it removes the answer to the case the ratio cannot see: that nothing in the catalog matches at all. |
| `PUBLIC_BASE_URL` | `BETTER_AUTH_URL`, else the request origin, else `http://localhost:3000` | **runtime** | Scheme + host used to build outward-facing URLs (A2A Agent Cards, Slack manifests, the OAuth callback, MCP client ID metadata documents). Behind a reverse proxy the request URL reflects the bind address, so this has to come from configuration. The request-origin step applies only where a request is at hand — the A2A Agent Card path has none, so with both variables unset a card advertises `localhost`. **The metadata document is the consumer that has to be publicly fetchable**, not merely correct: its URL *is* the OAuth `client_id`, which the authorization server retrieves. A loopback or plain-http value there is refused before the flow starts, and the connection falls back to dynamic registration where the provider offers it — see [SECURITY.md](SECURITY.md#mcp-oauth). |

### Choosing an embedding model

Measured through the whole pipeline against this deployment's registry, which is described in
English and queried in Korean:

| model | correct | unrelated | Korean query, English description |
|---|---|---|---|
| `amazon.titan-embed-text-v2:0` | 0.34–0.41 | 0.04–0.12 | **0.065** — indistinguishable from noise |
| `text-embedding-3-large` | 0.41–0.58 | 0.21–0.22 | 0.169 — *below* the noise |
| **`global.cohere.embed-v4:0`** | 0.30–0.53 | 0.21–0.24 | **0.393** — clear of it |

Only Cohere separates the case this deployment actually has. Under Titan, "깃헙 레포 알려줘"
scores 0.065 against the `github` server and 0.041 against an unrelated skill, so no threshold
finds it; under `3-large` it scores *below* the unrelated rows. Cohere costs about the same per
token as `3-large` and several times Titan, which at catalog volumes is a dollar or two a month
— the choice is accuracy, not price.

What Cohere costs instead is that everything scores higher, which is why `CATALOG_MIN_SCORE`
is 0.25 here and would be 0.15 under Titan. A deployment whose registry and requests share a
language will not see this difference and can use any of the three.

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
| `LLM_PROVIDER_<NAME>_BASE_URL` | unset | **runtime** | Registers a per-provider channel. `<NAME>` is the model id's provider prefix, upper-cased. The registry's providers are `OPENAI`, `ANTHROPIC`, `GOOGLE`, `XAI`, `BEDROCK`, `OPENROUTER`; the env parser accepts any `[A-Z0-9_]+` name, but a channel outside that list can never match a model id — the `/settings` override path refuses one outright. |
| `LLM_PROVIDER_<NAME>_API_KEY` | unset | **runtime** | Credential for that channel. Required unless `_AUTH=sigv4`: a channel with no key is **skipped silently**, and its models then fall through to the default channel. |
| `LLM_PROVIDER_<NAME>_AUTH` | `bearer` | **runtime** | `bearer` \| `sigv4`. `sigv4` signs each request with the process's AWS credentials (Pod Identity in the cluster, `AWS_PROFILE` locally) and takes **no API key**. Anything other than the literal `sigv4` reads as `bearer`, so a typo cannot produce an unsigned keyless channel. |
| `LLM_PROVIDER_<NAME>_KEEP_MODEL_PREFIX` | `false` | **runtime** | Provider channels receive the bare model name (the `provider/` prefix stripped). Set this when the channel is itself a router that expects full ids. |

> A base URL must include the API version path the provider serves from — the adapters append
> `/chat/completions` and `/images/generations` to it verbatim. `https://api.x.ai` instead of
> `https://api.x.ai/v1` makes **every** call to that provider a 404, text and image alike, and
> the symptom is a tool result reading `The requested resource was not found`. `pnpm
> check-models` reports each channel's reachability, which is the fastest way to see it.

When any provider channel is configured, `GET /api/models` lists only those providers'
models; with none configured it lists the whole registry.

A stored `llmProviders` override on `/settings` **replaces the entire `LLM_PROVIDER_*` env
set** rather than merging with it — a partial merge would make "remove this provider" an
unexpressible edit.

### Model registry: families and offerings

The selectable models live in `src/domain/llm/models.ts` and are hand-maintained, because
pricing, context windows and capability flags exist only in each provider's documentation.

The file holds two lists. A **family** states the model once — display name, price, window,
capabilities. An **offering** says a provider serves that family, under which wire name, and
what the route changes; `MODEL_CONFIGS` is derived from the pair, with id `provider/family`.
The same model reached three ways is therefore one set of numbers and three one-line routes:

```ts
{ family: "claude-opus-4.8", provider: "anthropic",  wireId: "claude-opus-4-8" },
{ family: "claude-opus-4.8", provider: "openrouter", wireId: "anthropic/claude-opus-4.8" },
```

An offering may override `pricing`, `capabilities`, `contextWindow`, `maxTokens` and
`hidden` — shallow merges, so it names only what differs. Overriding is for what the *route*
changes (a router's own rate, a gateway that cannot do structured output), never for what
the model is: `tests/models.test.ts` fails if two routes disagree about the name, the window
or whether the thing generates images.

Registry ids follow the router convention (`anthropic/claude-opus-4.8`), which is also what
stored project versions hold. When a route spells the model differently — Anthropic serves
`claude-opus-4-8` and 404s on the dotted form; OpenRouter serves
`anthropic/claude-opus-4.8`; Bedrock serves `openai.gpt-oss-120b` — set `wireId`; it is what
gets sent once the channel strips the prefix. Renaming an entry instead would orphan every
stored version that referenced the old id.

**Bedrock's model list is not a list of models this protocol can reach.** Its
OpenAI-compatible endpoint is `bedrock-mantle`
(`https://bedrock-mantle.<region>.api.aws/v1`, `_AUTH=sigv4`), and `GET /v1/models` there
returns models that `POST /v1/chat/completions` then refuses: every `anthropic.*` model
(they take the Anthropic Messages API, which this app does not speak) and `xai.grok-4.3`
(`isn't supported on this route`), both of which AWS also publishes prices for. So a
Bedrock offering is added only after a real call to it returns — the registry's are
open-weight models, each one smoke-tested. Note also that `bedrock-mantle` does not exist in
`ap-northeast-2`, so its base URL names a different region than the rest of the deployment;
the signer reads the region from that URL rather than from `AWS_REGION`.

**A channel that reports its own cost is believed.** OpenRouter returns `usage.cost` (USD)
on every call, and that figure — not the registry's rate — is what the usage row records.
Registry pricing stays the estimate shown before a run and the fallback for every channel
that reports tokens only.

**A model missing from the registry still runs by default, but its usage is priced at $0** —
so the gap is invisible in the cost dashboard it corrupts. Each miss logs `[cost] unknown
model id` once and increments `agentdure_unknown_model_calls_total`; alert on a non-zero
rate rather than waiting to notice the cost. `pnpm check-models` compares the registry against
what the configured channels actually serve — see [DEVELOPMENT.md](DEVELOPMENT.md#scripts).

| Variable | Default | Runtime | Notes |
|---|---|---|---|
| `UNKNOWN_MODEL_POLICY` | `allow` | **runtime** | `allow` \| `refuse`. Whether a run may execute a model the registry cannot price. Anything else reads as `allow`, so a malformed value never becomes the reason a deployment stops running. |

`refuse` is checked in the **run bracket**, the one point all four admitting functions pass,
and it covers the version's `fallbackModel` as well as its `model` — a fallback carries the
whole run whenever the primary is rate-limited, so an unpriced one leaks exactly as much, only
intermittently. It throws before dispatch, so the caller gets a `400` rather than a stream
that opens and then fails.

A **subagent transfer** is checked too, where the child's version resolves. It never opens a
bracket — it is not a top-level run — but it dispatches and books usage just the same, and the
parent's model says nothing about the child's. There a refusal fails the transfer rather than
the run: the parent is told why and can answer without that child.

**Saving a version is untouched**: storing an id the registry has
not caught up with is how a new model is adopted, and that path keeps its warning. What the
setting bounds is spending money under an id nothing can price.

## Execution limits

| Variable | Default | Runtime | Notes |
|---|---|---|---|
| `MAX_RUN_DURATION_MS` | `600000` (10 min) | — | Wall-clock cap on a single run, every entry point. A hung provider or tool call cannot run — or bill — unbounded. An invalid value is ignored with a warning. The Slack path additionally applies the fixed 3-minute interactive deadline (below), which can only shorten a run. Two derived values move with this one: the run-slot lease (this value plus 60s) and the MCP OAuth token refresh margin (this value plus 5 min). |
| `MAX_CONCURRENT_RUNS_PER_ACTOR` | `10` | — | Runs one caller may have in flight. `0` disables the limit. A member tier with its own `maxConcurrentRuns` (see *Limits fixed in code*) overrides this for that member's own runs — the default `guest` tier carries one; `admin`/`member`, project tokens, and every machine caller inherit this value. |
| `MAX_CONCURRENT_RUNS_A2A` | `50` | — | Separate ceiling for calls made with the **shared** A2A key, whose actor id is a constant: one identity stands for every machine caller there, and the per-caller limit would otherwise cap the whole A2A surface. A named client key is one caller and sits under `MAX_CONCURRENT_RUNS_PER_ACTOR` like a person. |
| `SCHEDULE_SCAN_TOKEN` | unset | — | The one credential every ticker presents (`X-Scan-Token`), shared by the three endpoints a CronJob POSTs: `/api/triggers/scan` (schedules), `/api/plugins/sync/scan` (the plugins repo) and `/api/catalog/reindex` (the capability catalog). Unset means this deployment has no ticker: all three answer 503 and schedule triggers never fire — off rather than open. |

Invalid values (non-integer, negative) degrade to the default with a warning rather than to
`0` — `Number("abc") || 0` would read as "limit off", which is the opposite of what a typo
should mean.

**Nearly every numeric setting in this document behaves that way**: they go through
`positiveIntEnv`, which `src/lib/config.ts` owns along with the parse and the warning. Two
kinds of setting sit outside it, and each says so in its own row: the `0`–`1` values
(`TRACE_SAMPLE_RATE`, `CATALOG_MIN_SCORE`) **clamp** instead of falling back, and
`MAX_RUN_DURATION_MS` parses itself in `src/shared/runDeadline.ts` — `application` needs the
deadline and may not import `lib` — validating it against `AbortSignal.timeout`'s domain and
degrading to the default with the same warning.

Which helper a setting calls is a separate question from where it *declares* itself: most do
that in `config.ts`, the retention windows in `src/infrastructure/db/ttl.ts`, and
`SETTINGS_CACHE_TTL_MS` in `src/lib/runtime-settings.ts`. Adapters never read the variable
themselves — `tests/architecture.test.ts` fails on a `process.env` read anywhere in `domain`,
`shared`, `infrastructure` or `application`, with `runDeadline.ts` the one **named** exception,
so a second one cannot arrive quietly. The warning is emitted once per setting per value,
because several of these are read on every row write.

## MCP

| Variable | Default | Runtime | Notes |
|---|---|---|---|
| `MCP_DISCOVERY_CACHE_TTL_MS` | `60000` | — | How long a bound server's tool list is reused, keyed by `url + headers`. A warm entry also lets the session connect lazily, so a turn that calls no tool makes no MCP request at all. `0` disables caching outright, and no server hint can switch it back on. Whole milliseconds. |
| `MCP_MAX_SERVER_TTL_MS` | `300000` (5 min) | — | Ceiling on the `ttlMs` a server may request on `tools/list` (SEP-2549). `0` ignores server hints entirely and returns every entry to the local TTL. Whole milliseconds. |
| `MCP_INTERNAL_HOST_SUFFIXES` | empty | — | Comma-separated DNS suffixes whose hosts an MCP entry may use despite resolving to a private address — typically `<namespace>.svc.cluster.local`. Empty leaves the SSRF guard exactly as it was. See [SECURITY.md](SECURITY.md#declared-internal-hosts). |
| `MANAGED_MCP_INSTANCE_ID` | unset | — | The host managed MCP containers are started on, through SSM Run Command. The literal value `local` runs Docker on this machine instead — app and container then share a loopback interface directly, which is the only way to exercise this path without EC2. |
| `MANAGED_MCP_REGISTRY` | unset | — | The registry `docker login` authenticates against, so this account's own images pull without a credential being typed. Images from any other registry the host can pull from are allowed; the login is simply skipped for them. |
| `MANAGED_MCP_NETWORK_CONTAINER` | `agentdure` | — | The container managed workloads share a network namespace with — this app's own. Every container has its own `127.0.0.1`, so a loopback address only means anything when both ends are in the same namespace. |

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
that is down — or a connection whose token was revoked — re-pays a failing connect before
the first token of every message. The window is short because a stale failure hides a
recovery while a stale success only serves a slightly old tool list.

## Source repository

| Variable | Default | Runtime | Notes |
|---|---|---|---|
| `PLUGINS_REPO` | unset | **runtime** | `owner/repo` of an [Agent Plugins 1.0.0](https://agent-plugins.org/) repository. Every directory holding a `plugin.json` — the repo root included — is one plugin; a root nested inside another is refused. Per plugin: `skills/<name>/SKILL.md` (Agent Skills spec — frontmatter `name` must match the directory, `description` required), `mcp.json` (only `type: "streamable-http"` servers are bound; `stdio` and `sse` entries are reported and skipped, never executed), and `org.opspresso.agentdure/mcp/<server>.md` extension documents carrying each server's description (frontmatter) and operator notes (body), which the closed mcp.json schema has no field for. |
| `PLUGINS_REPO_BRANCH` | `main` | **runtime** | |
| `GITHUB_TOKEN` | unset | **runtime** | Needs contents read access to the plugins repo. |

**The repository owns what it declared — by name; a person owns deletion.** An entry the
sync created, one it adopts from another origin (provenance is per plugin,
`github:<repo>#<plugin>`), and one registered by hand before any sync existed are all
brought to the repository's version automatically on every sync, provenance included; a
console edit to a name the repo declares is replaced. A hand-registered entry whose name no
plugin declares stays untouched. A name a previous sync created and the repository no
longer carries is only reported as orphaned, per plugin, and deleted when a person picks it
in the console — an MCP entry may hold credentials.

Headers declared in `mcp.json` are **not imported** — a secret does not belong in git — and
the dropped header names are reported. Credentials are set in the console after the sync,
and they never follow an address: when the repository moves a server's URL, the stored
headers and OAuth block are dropped and reported (`credentials-reset`) rather than sent to
the new host. A cluster-internal URL is registerable this way only if its host is covered by
`MCP_INTERNAL_HOST_SUFFIXES` — the sync faces the same outbound guard a typed URL does, and a
refusal is reported as a skip rather than failing the whole run.

Sync runs one at a time per repo (a second request answers 409), persists its report (shown
on `/plugins` across reloads), and can be ticked by the schedule CronJob via
`POST /api/plugins/sync/scan` (`X-Scan-Token`: the `SCHEDULE_SCAN_TOKEN`), which skips the
snapshot entirely while the branch head matches the last clean report.

## Slack

| Variable | Default | Runtime | Notes |
|---|---|---|---|
| `SLACK_LOADING_INDICATOR` | `:hourglass_flowing_sand:` | — | Appended to a Slack reply while it is still being written, then dropped by the final edit. **Only on the edit-in-place fallback** — a streamed reply is marked as still arriving by Slack itself. A workspace with its own spinner emoji names it here; the default is built in, because a custom name a workspace has not defined renders as literal text. |

Per-project Slack settings — the bot token, signing secret, suggested prompts and the **channel
keywords** that wake the bot without a mention — live on the project, not in the environment
(`/projects/{name}/settings`). Whether a version's runs may *read* the workspace is a version
parameter (`slackWorkspace`), off by default.

**The generated manifest changes with a release.** It now subscribes to `message.channels` and
`message.groups` and asks for `channels:read`; an app installed before that keeps the scopes and
events it was installed with, so a channel follow-up and the `SlackChannels` tool stay inert
until the manifest is applied again and the app reinstalled.

## A2A

| Variable | Default | Runtime | Notes |
|---|---|---|---|
| `A2A_API_KEY` | unset | **runtime** | Shared key for inbound A2A JSON-RPC (`X-A2A-Key`). The surface is off only when this is unset **and** no named client key exists (`/settings` → Client keys). Issue one from `/settings` rather than inventing it. |

Agent Card URLs are built from `PUBLIC_BASE_URL`.

## Observability and retention

| Variable | Default | Runtime | Notes |
|---|---|---|---|
| `TRACE_SAMPLE_RATE` | `0.1` | — | `0`–`1`, applied to top-level predict and image runs. Agent runs are always traced. Unlike the limits above, an out-of-range value **clamps** into the range rather than falling back — a rate of `2` means "as much as possible" — while a non-numeric one takes the default. Both say so in the log: a sampling rate that quietly became something else is how a deployment reasons from traces it never recorded. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | — | OTLP HTTP base endpoint (`/v1/traces` appended when absent). When set, every trace the platform persists is also exported as OTEL spans, after the DynamoDB write; export failures surface as `[otel]` log lines, never to the run. Unset means no export at all, and the OTEL SDK is never loaded. |
| `OTEL_EXPORTER_OTLP_HEADERS` | unset | — | Standard `key=value,key2=value2` form, sent on every OTLP request. Case-preserving: the values are collector credentials, and a normalised bearer token would be a different, wrong token. |
| `SETTINGS_CACHE_TTL_MS` | `5000` | — | In-memory TTL for the settings row. Bounds cross-instance staleness of every runtime override — see [Resolution order](#resolution-order). Floors at `1`, so `0` degrades to the default rather than disabling the cache. |
| `TRACE_RETENTION_DAYS` | `30` | — | DynamoDB TTL on the row's `expiresAt`. |
| `USAGE_RETENTION_DAYS` | `400` | — | Kept well beyond the dashboard's 184-day query window. Floors at `31` — a full month — because the monthly cost guard sums the month's daily rows, and a shorter window would silently under-count spend late in the month. |
| `CHAT_RETENTION_DAYS` | `180` | — | Measured from the chat's last activity. |
| `TRIGGER_RUN_RETENTION_DAYS` | `30` | — | Delivery history is an operational log, not a record to keep. |
| `A2A_TASK_RETENTION_DAYS` | `1` | — | Ephemeral job state, kept just long enough for `tasks/get`/`tasks/cancel` after `message/send`. |
| `ARTIFACT_RETENTION_DAYS` | `180` | — | Rows naming what runs produced. Matched to `CHAT_RETENTION_DAYS` by default, since that is already a generated image's effective lifetime. **Keep it ≥ `CHAT_RETENTION_DAYS`**: shorter and a picture still visible in a conversation disappears from its own gallery first. This window and the bucket's lifecycle rule are two independent settings — see [OPERATIONS.md](OPERATIONS.md#row-retention). |
| `AUDIT_RETENTION_DAYS` | `400` | — | Audit records. The longest window here with usage: the question an audit row answers is asked long after the act, and the row is one per sensitive act rather than one per run. |

Retention values are whole days, at least `1`; anything else falls back to the default **with
a warning**, like every other numeric setting here — the value an operator got wrong is the
one deciding how long a row survives, so a silent fallback is the worst kind. TTL has
to be **enabled on the `expiresAt` attribute of the production table** — see
[OPERATIONS.md](OPERATIONS.md#row-retention).

## Local scripts only

| Variable | Default | Notes |
|---|---|---|
| `MOCK_LLM_PORT` | `8002` | `scripts/mock-llm.ts` listen port. |
| `MOCK_LLM_DELAY_MS` | `0` | Milliseconds between streamed chunks; `0` sends them as fast as the socket takes. Raise it with the row below to reproduce a reply that scrolls. |
| `MOCK_LLM_CHUNKS` | `0` | Roughly how many chunks the answer is padded to; `0` keeps the one-line answer. |
| `INTEGRATION_MOCK_PORT` | `8002` | Mock LLM port used by `scripts/integration-check.ts`. Overridable so the check can run beside a mock already holding the default port; CI leaves it unset. |

## Limits fixed in code

These bound a run and are **not** environment-configurable. Each has a single owning file,
pinned by `tests/architecture.test.ts` where a second copy would drift.

| Limit | Value | Owner |
|---|---|---|
| Turns per agent run (version `maxTurn` default) | `50` | `src/application/llm/engine.ts` |
| Member tier limits — concurrent runs / monthly USD cap per member (`admin` —/—, `member` —/`20`, `guest` `1`/`2`; "—" inherits the env limit or is uncapped). `guest` additionally may not create projects or use project API tokens | `TIER_LIMITS` | `src/domain/member/tiers.ts` |
| Agents one `dispatch_agents` call may run | `4` | `src/application/llm/agentAssembly.ts` |
| Tool-result text per turn | `200,000` chars | `src/application/llm/toolResultBudget.ts` |
| Transfer transcript carried to a subagent | `8,000` chars | `src/application/llm/engine.ts` |
| Subagent nesting depth | `5` | `src/application/execution/subagentRunner.ts` |
| Addresses one run may read (`FetchUrl`) | `20` | `src/application/llm/engine.ts` |
| Bytes one `FetchUrl` may pull | `5 MB` | `src/application/llm/urlContent.ts` |
| Text kept from one fetched address | `90,000` chars | `src/application/llm/urlContent.ts` |
| HTML source read through before extracting | `500,000` chars | `src/infrastructure/llm/htmlText.ts` |
| A file one MCP tool result may carry | `10.5 MB` × 4 | `src/infrastructure/mcp/toolManager.ts` |
| Prompt excerpt kept on an artifact row | `500` chars | `src/application/artifact/storeArtifact.ts` |
| Capabilities one catalog search may add to a run (skills / external agents / MCP servers) | `5` / `3` / `3` | `src/application/execution/bindings.ts` |
| Catalog matches asked of each MCP index, oversampled past that cap — many tool rows collapse to one server, and a candidate the run cannot bind must cost no slot | `4×` (tool index) / `3×` (server index) the MCP server cap | `src/application/execution/bindings.ts` |
| What a run searches the catalog with (system prompt / newest user turns) | `2,000` chars / `3` turns | `src/application/execution/bindings.ts` |
| MCP tools declared per run | `120` | `src/domain/llm/toolLimits.ts` |
| A single MCP tool result | `100,000` chars | `src/infrastructure/mcp/toolManager.ts` |
| An MCP server's HTTP response | `14.5MB` | `src/infrastructure/mcp/session.ts` |
| `tools/list` pages read from one MCP server (the tail past them is dropped, with a warning) | `20` | `src/infrastructure/mcp/session.ts` |
| MCP OAuth metadata / token response | `256KB` each | `src/infrastructure/mcp/oauthMetadata.ts`, `oauthClient.ts` |
| MCP discovery cache entries | `200` | `src/infrastructure/mcp/discoveryCache.ts` |
| A remote agent's (A2A / external) response | `2MB` | `src/infrastructure/agent/dispatcher.ts`, `agentClient.ts` |
| Concurrent MCP calls per model response | `5` | `src/application/llm/engine.ts` |
| Interactive (Slack) run deadline | `3` min | `src/shared/runDeadline.ts` |
| Images per turn / bytes each | `4` / `5MB` | `src/domain/llm/imageLimits.ts` |
| Documents per turn / bytes each | `4` / `10MB` | `src/domain/llm/documentLimits.ts` |
| Extracted text kept, per document / per turn | `20,000` / `40,000` chars | `src/domain/llm/documentLimits.ts` |
| Request body carrying a turn (derived from the attachment caps) | ~`80MB` | `src/app/api/_lib/body.ts` |
| Request body of a registry or version edit (derived from the skill file caps) | `456KB` | `src/app/api/_lib/body.ts` |
| Transfer transcript line kept when a turn overflows | `500` chars minimum | `src/application/llm/engine.ts` |
| Context-budget estimate (ASCII / other / image part / headroom) | `3` chars per token / `1.5` tokens per char / `2,500` tokens / `2,000` tokens | `src/application/llm/contextBudget.ts` |
| Tool result kept when the run's context budget cuts it | `500` chars minimum | `src/application/llm/toolResultBudget.ts` |
| Chat history replayed into context | `200` messages / `200,000` chars | `src/application/chat/messageMapping.ts` |
| Chat tool traffic replayed into context | `3` turns / `20,000` chars | `src/application/chat/messageMapping.ts` |
| Inbound webhook / Slack event body | `1MB` each | `src/app/api/webhook/[project]/route.ts`, `src/app/api/slack/events/_lib/handleEventRequest.ts` |
| Slack thread turns used as context | `50` | `src/application/slack/handleSlackEvent.ts` |
| Slack thread title / history image lookback | `60` chars / `10` messages | `src/application/slack/handleSlackEvent.ts` |
| Slack suggested prompts per project | `4` | `src/domain/slack/types.ts` |
| Slack prompt title / message / agent description | `80` / `500` / `300` chars | `src/domain/slack/types.ts` |
| Slack channel keywords per project / length each | `20` / `2`–`50` chars | `src/domain/slack/types.ts` |
| How long the bot stays engaged in a channel thread it answered in (refreshed on every reply) | `24h` | `src/infrastructure/db/ttl.ts` |
| Rows a channel's progress checklist may grow to before further steps share one | `25` | `src/application/slack/replyStream.ts` |
| Messages one `SlackHistory`/`SlackThread` read returns (default / ceiling) | `20` / `100` | `src/application/slack/workspaceRead.ts` |
| Channels one `SlackChannels` listing returns | `200` | `src/application/slack/workspaceRead.ts` |
| People one Slack transcript or reaction list resolves to names | `25` | `src/application/slack/workspaceRead.ts` |
| `users.list` pages one `SlackUsers` search walks (it reports stopping) | `5` × `200` | `src/application/slack/workspaceRead.ts` |
| Matches one `SlackUsers` search prints (the rest are counted) | `20` | `src/application/slack/workspaceRead.ts` |
| Slack reply write cadence (stream / edit) | `1s` / `3s` | `src/application/slack/replyStream.ts` |
| Slack status refresh (Slack expires it at `2m`) | `45s` | `src/application/slack/replyStream.ts` |
| Slack profile cache (success / failure / entries) | `1h` / `1m` / `2000` | `src/infrastructure/slack/profileCache.ts` |
| Usage summary query range | `184` days | `src/app/api/usages/summary/validation.ts` |
| Schedule catch-up window (bounds what an outage can fire at once) | `10` min | `src/application/trigger/scanSchedules.ts` |
| Schedule firings one scan tick drives concurrently | `8` | `src/application/trigger/scanSchedules.ts` |
| Schedule repair sweep cadence (lost-run recovery) | every `5` min | `src/application/trigger/scanSchedules.ts` |
| Rows one repair sweep scans | `50` | `src/application/trigger/repairLostRuns.ts` |

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
