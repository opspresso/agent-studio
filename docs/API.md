# API Reference

HTTP API for Agent Studio. The full route list and design live in
[ARCHITECTURE.md](ARCHITECTURE.md); this document covers request/response shapes,
auth, and error cases for the non-obvious endpoints.

## Conventions

- **Content type**: requests and responses are JSON unless noted; streaming responses are
  `text/event-stream`.
- **Auth**: application routes require a Better Auth session cookie (Google OAuth login; for
  local dev, `scripts/dev-session.ts` prints one). Missing/invalid session →
  `401 { "error": "Unauthorized" }`. The login flow itself lives under `/api/auth/*`
  (Better Auth catch-all). The three execution endpoints (`predict`, `chat/completions`,
  `agent`) additionally accept a **per-project API token** via `Authorization: Bearer <token>`
  instead of a session cookie; the token acts on the project owner's behalf and is scoped to
  that project (see [Project API token](#project-api-token)). Webhooks are gated differently:
  `/api/a2a/*` by the `X-A2A-Key` header, `/api/slack/events/*` by the Slack signing secret,
  and `/api/health` (liveness, static 200) and `/api/ready` (readiness — 200, or 503 when
  DynamoDB / the LLM channel is unreachable or the instance is draining) are open.
- **Authorization**: projects are a shared catalog — any signed-in user may read and run any
  project. Only the owner may mutate one (update/delete/publish, version create/update, Slack
  config), otherwise `403 { "error": "You do not have permission to modify project \"…\"" }`.
  Two project sub-resources are owner-only to *read* as well — traces and the Slack config —
  because they expose other users' runtime data / masked secrets (403 for non-owners).
  Chats are per-owner private (non-owner reads return 404). MCP/agent/skill registries are
  shared for reads; mutations require membership in `ADMIN_EMAILS` when set (unset allows
  any signed-in user), otherwise `403 { "error": "Only admins can modify this resource" }`.
- **Errors**: `{ "error": string }`, with an extra `issues` array on schema-validation
  failures. Status codes: `400` (bad input), `401` (no session), `403` (not owner), `404`
  (missing), `409` (name conflict), `500` (unhandled).
- **List responses**: resource collections (`projects`, `skills`, `mcps`, `agents`) return a
  bare array; `chats`, `models`, and `usages/summary` wrap theirs in an object
  (`{ chats }`, `{ models }`, `{ items }` respectively).
- **SSE framing**: each event is `data: {json}\n\n`; OpenAI-style streams end with
  `data: [DONE]\n\n`. On a mid-stream failure a final `data: {"error":"…"}` frame is sent.
  `chat/completions` streams always carry exactly one `finish_reason` chunk: `stop` when the
  model finished on its own, `length` when an agent run ended at its turn budget.

## Resource CRUD — projects, skills, mcps, agents

All four follow the same shape. Example (skills):

```
GET    /api/skills            → 200 [ { name, description, content, createdAt, updatedAt }, … ]
GET    /api/skills/{name}     → 200 {…}                 | 404
POST   /api/skills            → 201 {…}                 | 409 (name exists) | 400
PUT    /api/skills/{name}     → 200 {…}                 | 404 | 400
DELETE /api/skills/{name}     → 204                     | 404
```

- Names are slugs (`^[a-z0-9-]+$`).
- `mcps`/`agents` store `headers` AES-encrypted and return them masked (length-preserving;
  9–20 chars reveal 2 at each end, 21+ reveal 4); a masked
  or empty value on update preserves the stored secret. Their `url` is SSRF-guarded — a
  private/loopback/link-local/metadata target (or non-http(s) scheme) is rejected with `400`.
- `mcps` also accept an optional `content` (markdown operator notes). `description` is the
  one-line summary the model sees in an agent run's server table; `content` is console-only
  and never reaches the model.
- `projects` mutations are owner-gated (403). `POST /api/projects` body:

```json
{ "name": "my-bot", "displayName": "My Bot", "description": "",
  "projectType": "llm | agent | image", "departmentCode": "OPT-optional" }
```

### Versions & publish

```
GET|POST /api/projects/{name}/versions
GET|PUT|DELETE /api/projects/{name}/versions/{version} ({version} = a name or "published")
POST     /api/projects/{name}/publish   { "versionName": "3" }   → sets the published pointer
```

Version body: `systemPrompt`, `userPromptTemplate`, `model` (required, `provider/model`),
`fallbackModel?`, `parameters { temperature?, maxTokens?, reasoningEffort?, piiFiltering,
structuredOutput?, jsonSchema?, imageGeneration?, imageModel? }`,
`mcpList[{ name, headers? }]`, `skillList[]`,
`subagentList[{ name, type: "local"|"remote" }]`, `maxTurn?`. An `imageModel` that is not an
image-capable registry model is rejected with 400. `mcpList`/`skillList`/`subagentList`
entries must resolve to registered MCP servers, skills, agents, or projects — a dangling
reference is rejected with 400. On update only *newly added* entries are checked, so a
version stays editable after a registry entry it already referenced is deleted.

#### MCP bindings and per-version header overrides

Each `mcpList` entry binds the version to a registry MCP server. The URL is always the
registry's; only headers may be redefined, so the same server can be called with different
credentials from different projects without registering it twice.

```json
"mcpList": [
  { "name": "shared-mcp",
    "headers": { "Authorization": "Bearer project-token", "X-Tenant": "acme", "X-Shared": null } }
]
```

- A string value replaces a registry default or adds a new header; `null` removes a registry
  default for this version. Matching is case-insensitive, as HTTP header names are.
- Omitting `headers` (or sending `{}`) uses the registry headers unchanged.
- A bare string entry — `"mcpList": ["shared-mcp"]`, the shape before overrides existed — is
  still accepted and normalizes to `{ "name": "shared-mcp" }`.
- Override values are AES-encrypted at rest and returned masked (same rule as registry
  headers); a masked or empty value on update preserves the stored secret, and a masked
  value under a header with no stored counterpart is dropped. `null` markers are returned
  as-is — a removal is not a secret.
- Editing overrides is owner-only, like every other version write.

## App settings

```
GET /api/settings → 200 { fields: { <key>: { value, source, secret } },
                          llmProviders: { source, items: [ { name, baseUrl, apiKey, keepModelPrefix } ] },
                          updatedAt? }
PUT /api/settings → 200 {…same shape…} | 400
```

- Admin-only (both verbs). Keys: `adminEmails`, `allowedEmailDomains`, `llmBaseUrl`,
  `llmApiKey`, `skillsRepo`, `skillsRepoBranch`, `githubToken`, `a2aApiKey`,
  `publicBaseUrl`.
- `llmProviders` on PUT is a full replacement list (per-provider LLM channels); an empty
  array removes the override (`LLM_PROVIDER_*` env fallback). A masked `apiKey` keeps the
  currently effective key for that provider name. Provider `name` must be one of
  `openai | google | anthropic | xai`.
- `source` is `override` (DB) | `env` | `default` | `unset`. Secret values are always masked
  (length-preserving; 9–20 chars reveal 2 at each end, 21+ reveal 4); a masked value on
  PUT keeps the stored secret, an empty string removes the override (env fallback). Setting `adminEmails` to a list that excludes
  the caller is rejected with `400`.

## Chats

Chats are private to their owner and run only against agent projects.

```
GET    /api/chats                         → { chats }
POST   /api/chats                         { projectName, firstMessage } → SSE
GET    /api/chats/{chatId}                → { chat, messages }
DELETE /api/chats/{chatId}                → 204
POST   /api/chats/{chatId}/messages       { content } → SSE
```

The create stream starts with `{ "chat": {…} }` so clients learn the new `chatId` before
assistant deltas. Message streams use the standard SSE framing and persist user, assistant,
tool, and generated-image display data. A project with neither a published version nor a
runnable draft is rejected with `400`.

## Registry and integration operations

These endpoints support the console's operational actions in addition to resource CRUD:

```
GET  /api/skills/sync
→ { configured, repo, branch }

POST /api/skills/sync
→ { repo, commitSha, synced, unchanged, skipped } | 503 (not configured)
  skipped: [{ name, path, reason }] — attachment files skipped during collection

POST /api/mcps/{name}/tools
→ { tools } | 502 (connection failure)

POST /api/agents/{name}/message   { "message": "hello" }
→ { text } | 502 (remote failure)

GET /api/projects/{name}/a2a
→ { enabled, published, cardUrl }
```

`GET /api/skills/sync` requires a session; its `POST` requires admin access. Registry test
operations require a session and apply the same SSRF guard used during registration and
dispatch.

Per-project Slack configuration uses these endpoints:

```
GET    /api/projects/{name}/slack
PUT    /api/projects/{name}/slack   { botToken?, signingSecret?, enabled? }
DELETE /api/projects/{name}/slack
POST   /api/projects/{name}/slack/test
```

Slack reads return masked credential state plus `eventsUrl` and a generated app manifest.
All four endpoints are owner-only (403 for non-owners) — the masked view still exposes the
bot token / signing secret edges. Masked or omitted secrets are preserved on update. The test endpoint returns
`{ ok: true, team, botUser }` or `502` for a Slack API failure.

## Project API token

A per-project token lets external callers reach the execution endpoints with
`Authorization: Bearer <token>` instead of a session cookie. Only the SHA-256 hash is
stored; the raw value is returned once at generation and cannot be retrieved again.

```
GET    /api/projects/{name}/token   → { configured, createdAt? }
POST   /api/projects/{name}/token   → { token, createdAt }   (raw token, shown once)
DELETE /api/projects/{name}/token   → 204
```

All three are owner-only (403 for non-owners). `POST` generates or regenerates the token —
regeneration overwrites the previous one, which stops working immediately. The token is
scoped to its project (validated against the `{name}` in the request path).

## Execution

The three endpoints below authenticate with either the session cookie or a project API
token (`Authorization: Bearer <token>`). A token authenticates as the project owner.

### `POST /api/projects/{name}/versions/{version}/predict`

Single-shot run. `{version}` may be `published`.

**Regardless of `projectType`** this endpoint runs one completion: an `agent`
project's MCP tools, skills, and subagents do **not** run here. That is what makes
`variables` (server-side `{{var}}` template rendering) available on this endpoint.
For the multi-turn tool loop use `chat/completions` or `agent` below.

```json
// request (llm/agent project)
{ "variables": { "topic": "otters" }, "messages": [ … ]?, "stream": false }
// response
{ "result": "…assistant text…", "model": "openai/gpt-5-mini",
  "usage": { "inputTokens": 12, "outputTokens": 34, … } }
```

For an `image` project, send `{ "prompt", "size?", "quality?" }` → `{ imageBase64, mimeType,
model, usage }`.
With `"stream": true`, the response is SSE.

### `POST /api/projects/{name}/versions/{version}/chat/completions`

OpenAI Chat Completions-compatible. `agent` projects run the multi-turn tool loop; others do a
single completion.

```json
// request
{ "model": "ignored-routes-by-version", "messages": [ { "role": "user", "content": "hi" } ],
  "variables": {}?, "stream": false }
// `temperature`/`max_tokens` are accepted but ignored — sampling comes from the
// version's stored `parameters`.
// response: an OpenAI chat.completion object (or chat.completion.chunk SSE when stream=true)
```

### `POST /api/projects/{name}/versions/{version}/agent`

Agent SSE stream. Body `{ "messages": [ … ] }`. Emits `EngineChunk` frames
(`delta.content`, `toolResult`, `author` for subagent turns, `error`) then `data: [DONE]`.

A transfer to a project already on the current transfer chain, or beyond 5 levels of
nesting, is refused as an authored error chunk rather than recursing.

## Usage

```
GET /api/usages/summary?from=2026-01-01&to=2026-01-31[&project=my-bot]
→ 200 { "items": [ { projectName, date, calls, inputTokens, outputTokens, costUsd }, … ] }
      (calls/inputTokens/outputTokens/costUsd are per-model maps: { "provider/model": number })
→ 400 { "error": "…" }   (bad/oversized range: max 184 days, from ≤ to)
```

## Traces

```
GET /api/projects/{name}/traces?limit=50[&from=2026-07-01&to=2026-07-31]
GET /api/projects/{name}/traces/{traceId}
```

`from`/`to` (YYYY-MM-DD, inclusive) filter the list by trace date via the GSI1 date key.

Both endpoints are owner-only (403 for non-owners) — traces hold other users' runtime
inputs/outputs. Agent runs are always traced. Text and image predict runs are sampled
according to `TRACE_SAMPLE_RATE` (0–1, default `0.1`). Trace spans contain model token/cost
summaries, tool input/output sizes, and local subagent trace links; raw prompts and tool
results are not persisted.

## Models

`GET /api/models` → `{ "models": [ { id, provider, displayName, pricing, capabilities, … } ] }`
(the registry from `src/domain/llm/models.ts`, hidden entries excluded). When per-provider
LLM channels are configured (settings override or `LLM_PROVIDER_*` env), only those
providers' models are listed; with none configured every model is listed.

## A2A (inbound)

Set `A2A_API_KEY` to enable. Each project with a published version serves a public Agent Card
and a JSON-RPC endpoint; see [README](../README.md#a2a-agent2agent) for the full contract.

```
GET  /api/a2a                                           (session) → { enabled, projects }
GET  /api/a2a/{project}/.well-known/agent-card.json     (public)
POST /api/a2a/{project}     X-A2A-Key: <key>            (JSON-RPC: message/send, message/stream,
                                                         tasks/get, tasks/cancel)
```

`GET /api/a2a` lists the published projects exposed over A2A: `enabled` reports whether
`A2A_API_KEY` is configured, and each project entry carries
`{ name, displayName, description, cardUrl }`.

Missing key → `503` (not configured) or `401` (mismatch, constant-time compared).
