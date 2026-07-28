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
  Two project sub-resources are limited to the owner and to admins for *reading* as well — traces and the Slack config —
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
- Editing overrides is limited to the owner and to admins, like every other version write.

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

```
POST /api/settings/a2a-key        → 200 { key, view }   (raw key)
POST /api/settings/a2a-key/reveal → 200 { key }         (raw key)
```

- Admin-only. Issues a fresh app-wide A2A key (`asa_` + 32 random bytes) as a settings
  override and returns it alongside the updated (masked) settings view. Reissuing
  invalidates the previous key immediately. A key pasted in by hand through `PUT /api/settings`
  still works — this endpoint only saves you from inventing one.
- `/reveal` returns the *effective* key in plaintext — the stored override decrypted, or the
  env value when there is no override — or `404` when none is configured. A POST although it
  reads, for the same reason as the project token: the body is a live credential. Every
  reveal is logged server-side with the caller's email.
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
POST   /api/chats                         { projectName, firstMessage, images? } → SSE
GET    /api/chats/{chatId}                → { chat, messages }
DELETE /api/chats/{chatId}                → 204
POST   /api/chats/{chatId}/messages       { content, images? } → SSE
```

The create stream starts with `{ "chat": {…} }` so clients learn the new `chatId` before
assistant deltas. Message streams use the standard SSE framing and persist user, assistant,
tool, and image display data. A project with neither a published version nor a runnable
draft is rejected with `400`.

`images` are the user's attachments as inline bytes — `[ { b64, mimeType } ]`, at most 4 per
turn, 5MB each, `image/png|jpeg|gif|webp`. A turn needs text or at least one image (both
empty → `400`). They reach the model as content parts and are stored (when object storage is
configured) as URLs on the user message.

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
All four endpoints are limited to the owner and to configured admins (403 for anyone else) — the masked view still exposes the
bot token / signing secret edges. Masked or omitted secrets are preserved on update. The test endpoint returns
`{ ok: true, team, botUser }` or `502` for a Slack API failure.

## Project API token

A per-project token lets external callers reach the execution endpoints with
`Authorization: Bearer <token>` instead of a session cookie. The token is stored
AES-256-GCM encrypted (not hashed) so the owner can read it back on request.

```
GET    /api/projects/{name}/token          → { configured, masked?, createdAt?, revealable? }
POST   /api/projects/{name}/token          → { token, masked, createdAt }   (raw token)
POST   /api/projects/{name}/token/reveal   → { token, createdAt }           (raw token)
DELETE /api/projects/{name}/token          → 204
```

Tokens are `ast_` + 32 random bytes (base64url). `masked` is the display mask recorded at
generation (`ast_••••…••wXyZ`) — the token itself stays unrecoverable, so this is the only
way the console can show *which* token is set without decrypting. It is absent on tokens
issued before masks were recorded; those keep working, since verification never looks at
the prefix.

All four are limited to the owner and to configured admins (403 for anyone else). `POST` generates or regenerates the token —
regeneration overwrites the previous one, which stops working immediately. The token is
scoped to its project (validated against the `{name}` in the request path).

`/reveal` is a POST although it reads: the body is a live credential, so it stays out of
caches, history and prefetches. `revealable` is `false` for a token issued before encrypted
storage — only its hash exists, so `/reveal` answers `400` with instructions to regenerate.
Verification accepts both forms (decrypt-and-compare in constant time, or hash comparison
for a legacy token). Every reveal is logged server-side with the caller's email.

## Execution

The three endpoints below authenticate with either the session cookie or a project API
token (`Authorization: Bearer <token>`). A token authenticates as the project owner.

### `POST /api/projects/{name}/versions/{version}/predict`

Runs the version. `{version}` may be `published`.

The endpoint dispatches on `projectType`, like `chat/completions`: an `llm` project runs one
completion with server-side `{{var}}` template rendering, and an **`agent` project runs its
multi-turn tool loop** with the version's MCP tools, skills and subagents. `variables` are
therefore ignored for an agent project — an agent run has no prompt template to render.

```json
// request (llm project)
{ "variables": { "topic": "otters" }, "messages": [ … ]?, "stream": false }
// request (agent project)
{ "messages": [ { "role": "user", "content": "hi" } ], "stream": false }
// response
{ "result": "…assistant text…", "model": "openai/gpt-5-mini",
  "usage": { "inputTokens": 12, "outputTokens": 34, … },
  "images": [ { "b64": "…", "mimeType": "image/png" } ]?  // only when the run drew something
}
```

For an `image` project, send `{ "prompt", "size?", "quality?", "images?" }` → `{ imageBase64,
mimeType, model, usage }`. `images` are source pictures as inline bytes
(`[ { b64, mimeType } ]`, same caps as a chat attachment): with any present the prompt
**edits** them, with none it draws from scratch.
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

**Image input.** A message body may be OpenAI content parts instead of a string. Image bytes
travel inline as a `data:image/…;base64,…` url; a remote image must be `https://`. One payload
is capped at 10MB, and the version's model must have the `imageInput` capability — otherwise
`400`, and a `fallbackModel` that cannot read images is skipped for that request.

```json
{ "messages": [ { "role": "user", "content": [
    { "type": "text", "text": "what is in this picture?" },
    { "type": "image_url", "image_url": { "url": "data:image/png;base64,iVBORw0…", "detail": "auto" } }
] } ] }
```

**Image output.** Images produced by a run (the `GenerateImage` / `EditImage` builtins, or an
`image` subagent) have no place in the OpenAI schema, so they ride along as an extension:
`images: [ { b64, mimeType, prompt? } ]` on the completion object, and `choices[0].delta.images`
frames in a stream. Clients that do not know the field simply ignore it.

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

Both endpoints are limited to the owner and to configured admins (403 for anyone else) — traces hold other users' runtime
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
