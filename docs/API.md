# API Reference

The HTTP contract for Agent Studio: every route, how it authenticates, and the request /
response shapes and error cases for the non-obvious ones.

Design rationale for *why* a surface looks like this lives in
[ARCHITECTURE.md](ARCHITECTURE.md); the authorization model is spelled out in
[SECURITY.md](SECURITY.md).

## Conventions

- **Content type**: requests and responses are JSON unless noted; streaming responses are
  `text/event-stream`.
- **Auth**: application routes require a Better Auth session cookie (Google OAuth login; for
  local dev, `scripts/dev-session.ts` prints one). Missing/invalid session →
  `401 { "error": "Unauthorized" }`. The login flow itself lives under `/api/auth/*`
  (Better Auth catch-all). The three execution endpoints (`predict`, `chat/completions`,
  `agent`) additionally accept a **per-project API token** via `Authorization: Bearer <token>`
  instead of a session cookie; the token acts on the project owner's behalf and is scoped to
  that project (see [Project API token](#project-api-token)). Machine surfaces are gated
  differently: `/api/a2a/*` by `X-A2A-Key`, `/api/slack/events/*` by the Slack signing secret,
  `/api/triggers/*` by the trigger's own secret. `/api/health`, `/api/ready` and
  `/api/metrics` are open.
- **Authorization**: projects are a shared catalog — any signed-in user may read and run any
  project. Only the owner and configured admins may mutate one (update/delete/publish, version
  create/update, Slack config), otherwise
  `403 { "error": "You do not have permission to modify project \"…\"" }`.
  Project sub-resources that expose other users' runtime data or masked secrets — traces, the
  Slack config, the API token, triggers, per-caller usage, MCP connections — are limited to
  the owner and admins for *reading* as well. Chats are per-owner private (non-owner reads
  return 404). MCP/agent/skill registries are shared for reads; mutations require membership
  in `ADMIN_EMAILS` when set (unset allows any signed-in user), otherwise
  `403 { "error": "Only admins can modify this resource" }`.
- **Errors**: `{ "error": string }`, with an extra `issues` array on schema-validation
  failures. Status codes: `400` (bad input), `401` (no session), `403` (not owner/admin),
  `404` (missing), `409` (name conflict), `413` (payload too large), `429` (refused for now —
  see below), `500` (unhandled), `502` (an upstream this app called failed), `503` (a feature
  this deployment did not configure).
- **Retry-After**: a `429` always carries it, in seconds. The refusal knows when it stops
  being true — a daily cost block lasts until 00:00 UTC — so the caller is told rather than
  left to guess and retry into the same wall.
- **List responses**: resource collections (`projects`, `skills`, `mcps`, `agents`) return a
  bare array; `chats`, `models`, `usages/summary`, `triggers`, `connections` wrap theirs in an
  object (`{ chats }`, `{ models }`, `{ items }`, `{ triggers }`, `{ connections }`).
- **Names** are slugs (`^[a-z0-9-]+$`), validated by `parseName`, which throws a
  `ValidationError` → `400`.
- **SSE framing**: each event is `data: {json}\n\n`; OpenAI-style streams end with
  `data: [DONE]\n\n`. On a mid-stream failure a final `data: {"error":"…"}` frame is sent.
  `chat/completions` streams always carry exactly one `finish_reason` chunk: `stop` when the
  model finished on its own, `length` when an agent run ended at its turn budget.

## Route index

`session` = Better Auth session cookie. `admin` = session + membership in the effective admin
list. `owner` = the project's owner or a configured admin.

### Projects

| Route | Methods | Auth |
|---|---|---|
| `/api/projects` | `GET` `POST` | session |
| `/api/projects/{name}` | `GET` `PUT` `DELETE` | session / owner |
| `/api/projects/{name}/versions` | `GET` `POST` | session / owner |
| `/api/projects/{name}/versions/{version}` | `GET` `PUT` `DELETE` | session / owner |
| `/api/projects/{name}/publish` | `POST` | owner |
| `/api/projects/{name}/preview` | `POST` | owner |
| `/api/projects/{name}/versions/{version}/predict` | `POST` | session or project token |
| `/api/projects/{name}/versions/{version}/chat/completions` | `POST` | session or project token |
| `/api/projects/{name}/versions/{version}/agent` | `POST` | session or project token |
| `/api/projects/{name}/token` | `GET` `POST` `DELETE` | owner |
| `/api/projects/{name}/token/reveal` | `POST` | owner |
| `/api/projects/{name}/traces` | `GET` | owner |
| `/api/projects/{name}/traces/{traceId}` | `GET` | owner |
| `/api/projects/{name}/usage/actors` | `GET` | owner |
| `/api/projects/{name}/triggers` | `GET` `POST` | owner |
| `/api/projects/{name}/triggers/{trigger}` | `PUT` `DELETE` | owner |
| `/api/projects/{name}/triggers/{trigger}/reveal` | `POST` | owner |
| `/api/projects/{name}/triggers/{trigger}/runs` | `GET` | owner |
| `/api/projects/{name}/slack` | `GET` `PUT` `DELETE` | owner |
| `/api/projects/{name}/slack/test` | `POST` | owner |
| `/api/projects/{name}/a2a` | `GET` | session |
| `/api/projects/{name}/mcp-connections` | `GET` | owner |
| `/api/projects/{name}/mcp-connections/{server}` | `PUT` `DELETE` | owner |
| `/api/projects/{name}/mcp-connections/{server}/authorize` | `POST` | owner |
| `/api/projects/{name}/mcp-connections/{server}/tools` | `POST` | owner |

### Registries

| Route | Methods | Auth |
|---|---|---|
| `/api/skills`, `/api/mcps`, `/api/agents` | `GET` `POST` | session / admin |
| `/api/skills/{name}`, `/api/mcps/{name}`, `/api/agents/{name}` | `GET` `PUT` `DELETE` | session / admin |
| `/api/skills/sync`, `/api/mcps/sync` | `GET` `POST` | session / admin |
| `/api/mcps/{name}/tools` | `POST` | session |
| `/api/mcps/{name}/auth` | `POST` `DELETE` | admin |
| `/api/mcps/managed` | `POST` | admin |
| `/api/mcps/managed/{name}` | `GET` `PUT` `DELETE` | admin |
| `/api/mcps/managed/{name}/restart` | `POST` | admin |
| `/api/mcps/oauth/callback` | `GET` | session |
| `/api/agents/{name}/message` | `POST` | session |

### Chats, usage, platform

| Route | Methods | Auth |
|---|---|---|
| `/api/chats` | `GET` `POST` | session |
| `/api/chats/{chatId}` | `GET` `DELETE` | owner of the chat |
| `/api/chats/{chatId}/messages` | `POST` | owner of the chat |
| `/api/usages/summary` | `GET` | session |
| `/api/models` | `GET` | session |
| `/api/me` | `GET` | session |
| `/api/settings` | `GET` `PUT` | admin |
| `/api/settings/a2a-key` | `POST` | admin |
| `/api/settings/a2a-key/reveal` | `POST` | admin |

### Unauthenticated / machine surfaces

| Route | Methods | Gate |
|---|---|---|
| `/api/auth/{...all}` | `GET` `POST` | the Better Auth login flow itself |
| `/api/a2a` | `GET` | session |
| `/api/a2a/{project}/.well-known/agent-card.json` | `GET` | public |
| `/api/a2a/{project}` | `POST` | `X-A2A-Key` |
| `/api/slack/events/{project}` | `POST` | Slack signing secret |
| `/api/triggers/{project}/{trigger}` | `POST` | `X-Trigger-Secret` |
| `/api/health` | `GET` | open |
| `/api/ready` | `GET` | open |
| `/api/metrics` | `GET` | open |

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

#### Daily cost limits

`PUT /api/projects/{name}` also carries the project's spend guards:

```json
{ "costLimits": { "alertThresholdUsd": 20, "blockThresholdUsd": 50,
                  "alertSlackChannel": "C0123456789" } }
```

Sent whole — the object replaces what was stored, `null` clears the guards, and omitting the
field leaves them untouched. A partial merge would make "drop the block threshold, keep the
alert" unexpressible. Both thresholds are optional and independent; `alertThresholdUsd` may
not exceed `blockThresholdUsd` (above it the alert could never fire on its own, because the
block stops the spending that would reach it).

Spend is the sum of every model's `costUsd` on the project's UTC-day usage row. Once it
reaches `blockThresholdUsd` every execution entry point answers
`429 { "error": "Project \"…\" has reached its daily cost limit …" }` with `Retry-After` set
to the seconds remaining until 00:00 UTC. Crossing either threshold posts once per day to
`alertSlackChannel` using the project's own Slack bot; without a channel or bot the
thresholds still block. See [OPERATIONS.md](OPERATIONS.md#daily-cost-guard--fails-open) for
what the guard does and does not bound.

### Versions & publish

```
GET|POST /api/projects/{name}/versions
GET|PUT|DELETE /api/projects/{name}/versions/{version} ({version} = a name or "published")
POST     /api/projects/{name}/publish   { "versionName": "3" }   → sets the published pointer
```

Version body: `systemPrompt`, `userPromptTemplate`, `model` (required, `provider/model`),
`fallbackModel?`, `parameters { temperature?, maxTokens?, reasoningEffort?, piiFiltering,
structuredOutput?, jsonSchema?, imageGeneration?, imageModel? }`,
`mcpList[{ name, headers?, tools? }]`, `skillList[]`,
`subagentList[{ name, type: "local"|"remote" }]`, `maxTurn?`. An `imageModel` that is not an
image-capable registry model is rejected with 400. `mcpList`/`skillList`/`subagentList`
entries must resolve to registered MCP servers, skills, agents, or projects — a dangling
reference is rejected with 400 — and only an `agent` project may carry them at all. On update
only *newly added* entries are checked, so a version stays editable after a registry entry it
already referenced is deleted.

#### MCP bindings and per-version header overrides

Each `mcpList` entry binds the version to a registry MCP server. The URL is always the
registry's; only headers may be redefined, so the same server can be called with different
credentials from different projects without registering it twice. `tools` narrows which of
that server's tools the run offers (absent or empty = all of them).

```json
"mcpList": [
  { "name": "shared-mcp",
    "tools": ["search", "fetch"],
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

A run declares at most 120 MCP tools in total and reports what it had to leave out as a
`warning` chunk.

### Prompt preview

```
POST /api/projects/{name}/preview
  { …an unsaved version body…, "variables": { "topic": "otters" }? }
→ 200 { messages: [ { role, content } ], … }
```

Assembles what the draft in the editor **would** send — system prompt, skill table, connected
MCP server table, rendered template — without running it.

Owner/admin, unlike reading or running a project: the body is an unsaved version, and its MCP
bindings may override the outbound headers a request carries to a registered server — the same
authority saving a version has. The URL always comes from the registry, so the SSRF surface is
a run's.

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

## Viewer

```
GET /api/me → 200 { email, isAdmin, isConfiguredAdmin }
```

Both flags are sent because they answer different questions and the console needs both:
`isAdmin` (may mutate shared registries and app settings — an empty `ADMIN_EMAILS` means *no
restriction*) and `isConfiguredAdmin` (may write a project owned by someone else — an empty
list means *nobody*). Neither is derivable in the browser, and inferring one from the other is
what once offered every signed-in user an edit form that 403'd on save. See
[SECURITY.md](SECURITY.md#isadminemail-vs-isconfiguredadmin).

## Chats

Chats are private to their owner and run only against agent projects.

```
GET    /api/chats                         → { chats }
POST   /api/chats                         { projectName, firstMessage, images?, documents? } → SSE
GET    /api/chats/{chatId}                → { chat, messages }
DELETE /api/chats/{chatId}                → 204
POST   /api/chats/{chatId}/messages       { content, images?, documents? } → SSE
```

The create stream starts with `{ "chat": {…} }` so clients learn the new `chatId` before
assistant deltas. Message streams use the standard SSE framing and persist user, assistant,
tool, and image display data. A project with neither a published version nor a runnable
draft is rejected with `400`.

`images` are the user's attachments as inline bytes — `[ { b64, mimeType } ]`, at most 4 per
turn, 5MB each, `image/png|jpeg|gif|webp`. They reach the model as content parts and are
stored (when object storage is configured) as URLs on the user message.

`documents` are files to read rather than look at — `[ { b64, mimeType, name } ]`, at most 4
per turn, 10MB each: PDF, plus text, Markdown, CSV/TSV, JSON, XML and HTML. `name` is
required and carries the decision when `mimeType` is `application/octet-stream`, which is how
uploads commonly arrive; an unreadable type is rejected with `400`. The server extracts the
**text** — a PDF's text layer, a text file's contents — and the turn carries that. The file
itself is never stored; the extracted text is, as `documents: [ { name, text, note? } ]` on
the user message, which is what lets a follow-up question still have the document. Up to
20,000 characters are kept per document and 40,000 across a turn; anything left out is
reported as a `warning`, as is a document that could not be read at all (a scan with no text
layer, a password-protected PDF).

A turn needs text or at least one attachment of either kind (all empty → `400`). Both chat
routes cap the request body at the largest a legitimate turn can be — every attachment at its
own limit plus room for prose — and answer `413` above it, checked against the declared length
before the body is read rather than after it is in memory.

The chat read (`GET /api/chats/{chatId}`) returns each document's `name` and `note` with an
empty `text`: the extracted text is what a *later turn* replays, read server-side, and
shipping it to the browser would put tens of thousands of characters per turn on the wire for
a view that renders neither.

## Registry and integration operations

These endpoints support the console's operational actions in addition to resource CRUD:

```
GET  /api/skills/sync
→ { configured, repo, branch }

POST /api/skills/sync
→ { repo, commitSha, synced, unchanged, skipped } | 503 (not configured)
  skipped: [{ name, path, reason }] — attachment files skipped during collection

GET  /api/mcps/sync
→ { configured, repo, branch }

POST /api/mcps/sync
→ { repo, commitSha, created, skipped } | 503 (not configured)
  skipped: [{ name, reason, detail? }]
  reason: exists | missing-url | invalid-url | bad-name

POST /api/mcps/{name}/tools
→ { tools } | 502 (connection failure)

POST /api/agents/{name}/message   { "message": "hello" }
→ { text } | 502 (remote failure)

GET /api/projects/{name}/a2a
→ { enabled, published, cardUrl }
```

Both sync endpoints answer `GET` to a session and require admin access for `POST`. Registry
test operations require a session and apply the same SSRF guard used during registration and
dispatch.

Both syncs follow one rule: **import what is missing, report the rest, decide nothing else.**

```
POST /api/skills/sync   { "overwrite"?: ["name"], "remove"?: ["name"] }
POST /api/mcps/sync     { "overwrite"?: ["name"], "remove"?: ["name"] }
→ 200 { repo, commitSha, created, existing, overwritten, orphaned, removed, skipped }
```

- **created** — in the repository, not in the registry. Imported outright.
- **existing** — in both, as `{ name, differs }` where `differs` names the fields the document
  would replace. **Nothing is written** unless the name is in `overwrite`: the stored version
  may be a correction someone made on purpose, and a sync cannot tell that apart from a
  document that moved on.
- **orphaned** — created by a previous sync of this repository and no longer in it. **Nothing
  is deleted** unless the name is in `remove`. Entries someone registered by hand never
  appear: they were never the repository's to miss.
- **skipped** — `bad-name`, `missing-url`, `invalid-url` (the outbound guard's message in
  `detail`), `managed-url` (a managed MCP entry's address comes from the provisioner, so the
  document's was ignored while its other fields applied), `conflict` (the name was taken
  mid-sync), `attachment` (a skill synced but one of its files did not).

An overwrite replaces only what the document owns — a skill's description, content and
attachments; an MCP entry's `url`, `description` and `content`. Encrypted headers, a
discovered OAuth block and a managed entry's provisioned address are never touched, and a
field the document does not carry leaves the stored one alone. Moving an MCP entry's address
drops the OAuth block read from the old one, so Discover has to be re-run.

An upstream failure (GitHub unreachable, a truncated tree) answers `502` through `apiError`
like every other route; a missing `SKILLS_REPO`/`TOOLS_REPO` or `GITHUB_TOKEN` answers `503`.

Per-project Slack configuration uses these endpoints:

```
GET    /api/projects/{name}/slack
PUT    /api/projects/{name}/slack   { botToken?, signingSecret?, enabled?, suggestedPrompts? }
DELETE /api/projects/{name}/slack
POST   /api/projects/{name}/slack/test
```

`suggestedPrompts` is `{ title, message }[]`, at most four; blank rows are dropped and a row
with only one half is a 400. Unlike the two credentials it is not a secret and comes back as
stored.

Slack reads return masked credential state plus `eventsUrl`, `suggestedPrompts` and a generated
app manifest.
All four endpoints are limited to the owner and to configured admins (403 for anyone else) — the masked view still exposes the
bot token / signing secret edges. Masked or omitted secrets are preserved on update. The test endpoint returns
`{ ok: true, team, botUser }` or `502` for a Slack API failure.

## Managed MCP servers

A managed server is a container this deployment starts on its own host through SSM Run
Command and reaches on loopback. All four endpoints are **admin-only**, and all four answer
`503 { "error": "This deployment is not configured to run managed MCP servers." }` when
`MANAGED_MCP_INSTANCE_ID` / `MANAGED_MCP_REGISTRY` are unset — the feature is off rather than
half-enabled.

```
POST   /api/mcps/managed              → 201 { …registry entry… }   | 409 | 400 | 503
GET    /api/mcps/managed/{name}       → 200 { name, image?, running, reachable, address?, detail? }
PUT    /api/mcps/managed/{name}       → 200 { …entry… }            | 404 | 409 | 400
DELETE /api/mcps/managed/{name}       → 204
POST   /api/mcps/managed/{name}/restart → 202 (no body)            | 409 (restart in flight)
```

Create body:

```json
{ "name": "my-tool", "image": "…/my-mcp:1.4.0", "containerPort": 8080,
  "args": ["--port", "{{PORT}}"]?, "endpointPath": "/mcp"?,
  "environment": { "LOG_LEVEL": "info" }?, "envRefs": ["/agent-studio/my-tool/API_KEY"]?,
  "description": ""?, "content": ""?, "headers": {}? }
```

- `name` is a slug (`^[a-z0-9][a-z0-9-]{0,62}$`) because it is also the container's name.
- `args` is an **argv array**, never a shell command; at most 64 entries, each ≤1024 chars and
  free of control characters. `{{PORT}}` in an argument is substituted with the effective
  listen port, for images that do not honour the `PORT` environment variable.
- `environment` values are encrypted in the registry row, masked on reads, and decrypted only
  when building the workload spec. `PORT` is rejected — the runtime owns it. Use `envRefs`
  when the value should stay in Parameter Store instead.
- `image` may come from any registry the host can pull from; `MANAGED_MCP_REGISTRY` is the one
  `docker login` authenticates against, and the login is skipped for anything else.
- `containerPort` is a request, not a guarantee: only an adapter that publishes a port mapping
  can honour it. The deployed adapter shares a network namespace instead, so it tells the
  container which port to bind (`PORT`) and ignores the stored value.

`GET` reports what is **actually running**, which the stored entry cannot say on its own.
`running` and `reachable` are separate on purpose: "running and unreachable" is a real state —
a container stranded in a network namespace by a redeploy is healthy to `docker inspect` and
addressable by nobody — and reporting only the first is what let one look healthy for half a
day.

`PUT` updates stored settings and restarts automatically when the workload spec changed.
`DELETE` removes the container and the entry together; neither outlives the other.

`POST …/restart` re-creates the container against the namespace this app has *now* — the
recovery after a redeploy stranded it. It answers **202 with no body**: starting a container
polls the runtime for minutes, far longer than any client will wait, so the caller polls `GET`
for the outcome. No body, because the stored entry carries encrypted header values and this is
not a read path that masks them.

## MCP OAuth

Two halves with different owners: the **registry entry's** authorization-server metadata is
operator configuration (admin), while the **credentials** that use it are per project (owner)
— which is why one shared entry can back a different provider app in each project.

### Discovery (admin)

```
POST   /api/mcps/{name}/auth   { "authorizationServer": "https://…"? }
→ 200 { status: "discovered", auth: {…} }
→ 200 { status: "choose", resource: "…", authorizationServers: ["…", "…"] }
DELETE /api/mcps/{name}/auth   → 204     (return the entry to static-header behaviour)
```

Follows RFC 9728 protected-resource metadata → RFC 8414 authorization-server metadata, with
every discovered endpoint re-validated through the SSRF policy and required to be `https`.
When the resource advertises more than one authorization server the call returns `choose`;
repeat it with `authorizationServer` set to one of the advertised values.

A server that publishes no usable document — or cannot be reached — answers **400** with the
candidate URLs it tried and why each failed. Reaching an entry on a
[declared internal host](SECURITY.md#declared-internal-hosts) works here as it does for a run.

Editing the entry's **URL** drops the `auth` block outright — it was read out of the old
address's well-known documents.

### Connections (owner)

```
GET    /api/projects/{name}/mcp-connections
→ 200 { connections: [ { serverName, status, clientId, clientSecret?, clientRegistered,
                         scopes, connectedBy?, connectedAt?, expiresAt? } ] }

PUT    /api/projects/{name}/mcp-connections/{server}
       { clientId, clientSecret?, scopes?: [] }        → 200 { …connection view… }
DELETE /api/projects/{name}/mcp-connections/{server}   → 204

POST   /api/projects/{name}/mcp-connections/{server}/authorize
→ 200 { url: "https://provider/authorize?…" }

POST   /api/projects/{name}/mcp-connections/{server}/tools
       { headerOverrides?: { "X-Tenant": "acme", "X-Shared": null } }
→ 200 { tools } | 502 { error }
```

- `status` is `needs_auth` | `connected` | `needs_reauth`. Only a **refused grant** moves a
  connection to `needs_reauth`; a 5xx or timeout leaves it alone.
- `clientSecret` is masked on read and **tokens are never returned** — unlike the A2A key and
  the project API token there is no reveal path, because a token has no reason to be
  displayed. On write, an omitted or masked value keeps what is stored; an **empty** one
  clears it, which is the only way back from a confidential client to a public one.
- `clientRegistered` is `true` when the credentials came from RFC 7591 dynamic registration
  rather than being entered by hand.
- `/authorize` **returns** the provider URL rather than issuing a `3xx`: the caller is the
  console's `fetch`, which would follow a redirect itself instead of sending the user.
- `/tools` lists the server's tools **as this project sees them** — with the project's own
  connection and the binding's header overlay. Distinct from the registry's own
  `POST /api/mcps/{name}/tools` probe, which carries only the entry's static headers and can
  do nothing but 401 against an OAuth server. Owner-gated for the same reason: it spends the
  project's connection.

### Callback

```
GET /api/mcps/oauth/callback?code=…&state=…&iss=…    (session)
```

The authorization server redirects the **browser** here, so it answers a small self-closing
HTML page rather than JSON: it `postMessage`s the outcome to its opener and closes, and still
reads sensibly if it was opened in a plain tab. Status is `200` either way — the status
describes serving the page; the outcome is in the message. `Cache-Control: no-store`, since it
carries a one-time result.

The callback validates RFC 9207 `iss` before the code is redeemed and re-checks project
ownership, which can change while the user is at the provider. See
[SECURITY.md](SECURITY.md#mcp-oauth) for the full set of checks.

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

All three are bounded by `MAX_RUN_DURATION_MS`, the per-caller concurrency guard, and the
project's daily cost guard — any of which answers `429` with `Retry-After`.

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
(`delta.content`, `toolResult`, `warning`, `image`, `author` for subagent turns, `error`) then
`data: [DONE]`. The full field contract is in
[ARCHITECTURE.md](ARCHITECTURE.md#enginechunk-contract).

A transfer to a project already on the current transfer chain, or beyond 5 levels of
nesting, is refused as an authored error chunk rather than recursing.

## Usage

```
GET /api/usages/summary?from=2026-01-01&to=2026-01-31[&project=my-bot]
→ 200 { "items": [ { projectName, date, calls, inputTokens, outputTokens, costUsd }, … ] }
      (calls/inputTokens/outputTokens/costUsd are per-model maps: { "provider/model": number })
→ 400 { "error": "…" }   (bad/oversized range: max 184 days, from ≤ to)
```

### Per-caller spend

```
GET /api/projects/{name}/usage/actors?from=2026-07-01&to=2026-07-31
→ 200 { "items": [ { projectName, date, actor, calls, inputTokens, outputTokens, costUsd,
                     display?: { name, avatarUrl? } }, … ] }
```

`actor` is `{kind}:{id}` — `user:a@example.com`, `project-token:owner@example.com` (a token
authenticates as its owner, so the kind is what keeps a machine's spend apart from that
person's own runs), `slack:U123`, `a2a:shared-key`. The metric fields are per-model maps,
exactly as in the summary above.

`display` puts a face on a `slack:` row, resolved through the project's own bot token. It is
decoration and may be absent for any reason — no Slack bot, a revoked token, a deactivated user,
a Slack outage — and `actor` is unchanged in every case, because that is the key two callers are
told apart by.

Owner/admin only, on the same reasoning as traces: project *totals* are open to any
signed-in user because the catalog is shared, but a breakdown by caller names individuals.
Range validation matches `/api/usages/summary` (both dates required, `from ≤ to`, ≤ 184
days). Subagent transfers are attributed to whoever started the run, not to the project
they transferred into.

## Webhook triggers

Configuration (owner/admin):

```
GET    /api/projects/{name}/triggers                     → 200 { triggers: [ … ] }
POST   /api/projects/{name}/triggers                     → 201 { …, secret }   | 409
PUT    /api/projects/{name}/triggers/{trigger}           → 200 { … }           | 404
DELETE /api/projects/{name}/triggers/{trigger}           → 204                 | 404
POST   /api/projects/{name}/triggers/{trigger}/reveal    → 200 { secret, createdAt }
GET    /api/projects/{name}/triggers/{trigger}/runs?limit=20 → 200 { runs: [ … ] }
```

Create body: `{ triggerId (slug), description?, enabled?, variables?, payloadMode?,
allowConcurrent? }`. `triggerId` follows the same rule as a project name
(`^[a-z0-9-]+$`); the console normalises what you type through the same `toSlug` helper the
project form uses, and the API rejects anything else regardless of client.

Ordinary reads return `secretMasked` only. The secret is stored AES-encrypted rather than
hashed, so — exactly like a project API token — it can be **read back** through
`POST …/reveal` (a POST because the body is a live credential; owner/admin only, and every
reveal is logged with the caller's email). `PUT` with `rotateSecret: true` re-issues it and
returns the new one; the previous secret stops working immediately.

Delivery (no session — the secret is the authentication):

```
POST /api/triggers/{project}/{trigger}
  X-Trigger-Secret: asw_…
  Idempotency-Key: <optional>
  { "any": "json payload" }
→ 202 { ok: true, status: "accepted", runId }
→ 202 { ok: true, status: "duplicate" | "disabled" | "busy" | "no-published-version" }
→ 401 (wrong or missing secret) | 404 (no such trigger) | 400 (bad JSON) | 413 (>1MB)
```

`202` even for the refusals a caller cannot fix by retrying: the delivery was accepted and
its outcome is recorded, which is where an operator looks. Only `accepted` starts a run.

The endpoint answers immediately and runs in the background — a run can last ten minutes and
no webhook sender waits that long, so the result is on the delivery's history row rather than
in the response. A trigger always runs the project's **published** version.

`payloadMode: "message"` (the default) serialises the payload into the user turn — what an
agent project reads. `"variables"` flattens the payload's scalar top-level fields over the
trigger's fixed `variables` for a prompt template; non-scalar fields are dropped rather than
rendered as `[object Object]`.

`allowConcurrent` is false by default: a second delivery while one is still running is
recorded as `skipped` rather than piling runs up.

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
results are not persisted. Each trace also carries `actor` — who caused the run — and a
subagent's trace carries the actor of the top-level run that reached it, since the transfer
was not a second person's decision.

## Models

`GET /api/models` → `{ "models": [ { id, provider, displayName, pricing, capabilities, … } ] }`
(the registry from `src/domain/llm/models.ts`, hidden entries excluded). When per-provider
LLM channels are configured (settings override or `LLM_PROVIDER_*` env), only those
providers' models are listed; with none configured every model is listed.

## A2A (inbound)

Set `A2A_API_KEY` to enable. Each project with a published version serves a public Agent Card
and a JSON-RPC endpoint.

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

Agent Card URLs are built from `PUBLIC_BASE_URL`. Task state (`message/send` →
`tasks/get`/`tasks/cancel`) is persisted per project in DynamoDB, so it survives redeploys and
is shared across instances; a terminal-state-guarding conditional write keeps a concurrent
complete/cancel from regressing a finished task. Rows expire via TTL
(`A2A_TASK_RETENTION_DAYS`, default 1 day).

## Platform endpoints

```
GET /api/health   → 200 (static)
GET /api/ready    → 200 { ready: true, … } | 503 { ready: false, draining?: true }
GET /api/metrics  → 200 text/plain; version=0.0.4
```

`/api/health` is liveness — a static 200 answering "is the process serving", dependency-free
so a downstream blip does not trigger a restart. `/api/ready` is readiness — it probes
DynamoDB and the LLM channel (short timeout, details not surfaced) and returns 503 when a
downstream is unreachable or the instance is draining after SIGTERM.

`/api/metrics` is a Prometheus scrape exposing `agent_studio_active_runs`,
`agent_studio_runs_{started,finished,failed}_total`, `agent_studio_run_duration_seconds`,
`agent_studio_unknown_model_calls_total`, `agent_studio_unknown_models` and
`agent_studio_draining`. No metric is labelled by project, user or model.

All three are unauthenticated and dependency-light on purpose — they are probed by
infrastructure that has no session. See [OPERATIONS.md](OPERATIONS.md#health-probes) for how
to wire them.
