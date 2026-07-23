# API Reference

HTTP API for Agent Studio. The full route list and design live in
[ARCHITECTURE.md](ARCHITECTURE.md); this document covers request/response shapes,
auth, and error cases for the non-obvious endpoints.

## Conventions

- **Content type**: requests and responses are JSON unless noted; streaming responses are
  `text/event-stream`.
- **Auth**: application routes require a Better Auth session cookie (Google OAuth login; for
  local dev, `scripts/dev-session.ts` prints one). Missing/invalid session →
  `401 { "error": "Unauthorized" }`. Webhooks are gated differently: `/api/a2a/*` by the
  `X-A2A-Key` header, `/api/slack/events/*` by the Slack signing secret, `/api/health` is open.
- **Authorization**: projects are a shared catalog — any signed-in user may read and run any
  project. Only the owner may mutate one (update/delete/publish, version create/update, Slack
  config), otherwise `403 { "error": "You do not have permission to modify project \"…\"" }`.
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
- `mcps`/`agents` store `headers` AES-encrypted and return them masked (length-preserving asterisks); a masked
  or empty value on update preserves the stored secret. Their `url` is SSRF-guarded — a
  private/loopback/link-local/metadata target (or non-http(s) scheme) is rejected with `400`.
- `projects` mutations are owner-gated (403). `POST /api/projects` body:

```json
{ "name": "my-bot", "displayName": "My Bot", "description": "",
  "projectType": "llm | agent | image", "departmentCode": "OPT-optional" }
```

### Versions & publish

```
GET|POST /api/projects/{name}/versions
GET|PUT  /api/projects/{name}/versions/{version}     ({version} = a name or "published")
POST     /api/projects/{name}/publish   { "versionName": "3" }   → sets the published pointer
```

Version body: `systemPrompt`, `userPromptTemplate`, `model` (required, `provider/model`),
`fallbackModel?`, `parameters { temperature?, maxTokens?, reasoningEffort?, piiFiltering,
structuredOutput?, jsonSchema?, imageGeneration?, imageModel? }`, `mcpList[]`, `skillList[]`,
`subagentList[{ name, type: "local"|"remote" }]`, `maxTurn?`. An `imageModel` that is not an
image-capable registry model is rejected with 400.

## App settings

```
GET /api/settings → 200 { fields: { <key>: { value, source, secret } },
                          llmProviders: { source, items: [ { name, baseUrl, apiKey, keepModelPrefix } ] },
                          updatedAt? }
PUT /api/settings → 200 {…same shape…} | 400
```

- Admin-only (both verbs). Keys: `adminEmails`, `allowedEmailDomains`, `llmBaseUrl`,
  `llmApiKey`, `slackDefaultProject`, `slackBotToken`, `slackSigningSecret`, `skillsRepo`,
  `skillsRepoBranch`, `githubToken`, `a2aApiKey`, `publicBaseUrl`.
- `llmProviders` on PUT is a full replacement list (per-provider LLM channels); an empty
  array removes the override (`LLM_PROVIDER_*` env fallback). A masked `apiKey` keeps the
  currently effective key for that provider name. Provider `name` must be one of
  `openai | google | anthropic | xai`.
- `source` is `override` (DB) | `env` | `default` | `unset`. Secret values are always masked
  (length-preserving asterisks); a masked value on PUT keeps the stored secret, an empty
  string removes the override (env fallback). Setting `adminEmails` to a list that excludes
  the caller is rejected with `400`.

## Execution

### `POST /api/projects/{name}/versions/{version}/predict`

Single-shot run. `{version}` may be `published`.

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

## Usage

```
GET /api/usages/summary?from=2026-01-01&to=2026-01-31[&project=my-bot]
→ 200 { "items": [ { projectName, date, calls, inputTokens, outputTokens, costUsd }, … ] }
      (calls/inputTokens/outputTokens/costUsd are per-model maps: { "provider/model": number })
→ 400 { "error": "…" }   (bad/oversized range: max 184 days, from ≤ to)
```

## Models

`GET /api/models` → `{ "models": [ { id, provider, displayName, pricing, capabilities, … } ] }`
(the registry from `src/domain/llm/models.ts`, hidden entries excluded). When per-provider
LLM channels are configured (settings override or `LLM_PROVIDER_*` env), only those
providers' models are listed; with none configured every model is listed.

## A2A (inbound)

Set `A2A_API_KEY` to enable. Each project with a published version serves a public Agent Card
and a JSON-RPC endpoint; see [README](../README.md#a2a-agent2agent) for the full contract.

```
GET  /api/a2a/{project}/.well-known/agent-card.json     (public)
POST /api/a2a/{project}     X-A2A-Key: <key>            (JSON-RPC: message/send, message/stream,
                                                         tasks/get, tasks/cancel)
```

Missing key → `503` (not configured) or `401` (mismatch, constant-time compared).
