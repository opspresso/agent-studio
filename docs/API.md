# API Reference

The HTTP contract for AgentDure: every route, how it authenticates, and the request /
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
  `/api/triggers/{project}/{trigger}` by the trigger's own secret, `/api/triggers/scan` by the
  deployment's `SCHEDULE_SCAN_TOKEN`. `/api/health`, `/api/ready` and `/api/metrics` are open.
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
  model finished on its own, `length` when the run ended at a limit — its turn budget, or the
  provider cutting the response at its output cap — read from the termination the engine
  announces, so a cancellation or a mid-stream error is never dressed up as a length stop.
  The non-streaming response reports the same two values.

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
| `/api/projects/{name}/preview` | `POST` | session |
| `/api/projects/{name}/versions/{version}/predict` | `POST` | session or project token |
| `/api/projects/{name}/versions/{version}/chat/completions` | `POST` | session or project token |
| `/api/projects/{name}/versions/{version}/agent` | `POST` | session or project token |
| `/api/projects/{name}/token` | `GET` `POST` `DELETE` | owner |
| `/api/projects/{name}/token/reveal` | `POST` | owner |
| `/api/projects/{name}/artifacts` | `GET` | owner |
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
| `/api/plugins` | `GET` | session |
| `/api/plugins/{name}` | `GET` | session |
| `/api/plugins/sync` | `GET` `POST` | session / admin |
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
| `/api/chats/{chatId}/runs/{runId}` | `GET` `DELETE` | owner of the chat |
| `/api/chats/{chatId}/runs/{runId}/stream` | `GET` | owner of the chat |
| `/api/artifacts` | `GET` | session |
| `/api/artifacts/{artifactId}` | `DELETE` | creator, project owner, or admin |
| `/api/usages/summary` | `GET` | session |
| `/api/models` | `GET` | session |
| `/api/models/catalog` | `GET` | admin |
| `/api/models/test` | `POST` | admin |
| `/api/me` | `GET` | session |
| `/api/me/profile` | `GET` | session |
| `/api/members` | `GET` | admin |
| `/api/settings` | `GET` `PUT` | admin |
| `/api/settings/a2a-key` | `POST` | admin |
| `/api/settings/a2a-key/reveal` | `POST` | admin |
| `/api/settings/a2a-keys` | `GET` `POST` | admin |
| `/api/settings/a2a-keys/{name}` | `DELETE` | admin |
| `/api/settings/a2a-keys/{name}/reveal` | `POST` | admin |
| `/api/audit` | `GET` | admin |

### Unauthenticated / machine surfaces

| Route | Methods | Gate |
|---|---|---|
| `/api/auth/{...all}` | `GET` `POST` | the Better Auth login flow itself |
| `/api/a2a` | `GET` | session |
| `/api/a2a/{project}/.well-known/agent-card.json` | `GET` | public |
| `/api/a2a/{project}` | `POST` | `X-A2A-Key` |
| `/api/slack/events/{project}` | `POST` | Slack signing secret |
| `/api/triggers/{project}/{trigger}` | `POST` | `X-Trigger-Secret` |
| `/api/triggers/scan` | `POST` | `X-Scan-Token` |
| `/api/catalog/reindex` | `POST` | `X-Scan-Token` |
| `/api/plugins/sync/scan` | `POST` | `X-Scan-Token` |
| `/api/health` | `GET` | open |
| `/api/ready` | `GET` | open |
| `/api/metrics` | `GET` | open |

## Resource CRUD — projects, skills, mcps, agents

All four follow the same shape. Example (skills):

```
GET    /api/skills            → 200 [ { name, description, source?, files, updatedAt }, … ]
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
- `agents` carry a `protocol` (`openai` | `a2a`, default `openai`) that decides how
  `POST /api/agents/{name}/message` and an outbound transfer address the remote.
- A **managed** MCP entry is refused by the shared registry routes it does not own:
  `DELETE /api/mcps/{name}` is `400` (delete it through `/api/mcps/managed/{name}`, so the
  container stops with the row), and a `PUT` that moves its `url` is `400` — the address comes
  from the provisioner.
- `GET /api/skills` returns summaries — `{ name, description, source?, files: count,
  updatedAt }` — because the list pages render a card, not a document; the full entity
  (markdown `content`, the attachment `files[]` themselves) comes from
  `GET /api/skills/{name}`. `source?` is the provenance of a repo-synced entry, e.g.
  `github:opspresso/agent-plugins#devops` — the repo and the plugin that declared it.
- **A `source`-bearing entry is repo-owned, and the console refuses to compete with the
  repository over it (`403`)**: a skill's `PUT`/`DELETE` entirely; an MCP entry's `url`,
  `description`, `content` and its `DELETE` — a headers-only `PUT` still passes, because
  credentials are console-owned and never in git (OAuth likewise). A managed synced entry
  keeps its workload fields (`image`, ports, env) editable. Deletion of a repo-owned entry
  happens through the plugins sync's orphan selection.
- `projects` mutations are owner-gated (403). `POST /api/projects` body:

```json
{ "name": "my-bot", "displayName": "My Bot", "description": "",
  "projectType": "llm | agent | image", "departmentCode": "OPT-optional" }
```

  Creation also writes the project's initial version `"1"` — empty prompts, the deployment's
  first offered model that fits the project type — so chat and the playground work from the
  first minute. The initial version is **not published**: publishing stays a deliberate act
  (the console offers it after a save while the project is unpublished). With no offered
  model that fits, the project is created without a version, exactly as before.

#### Cost limits

`PUT /api/projects/{name}` also carries the project's spend guards:

```json
{ "costLimits": { "alertThresholdUsd": 20, "blockThresholdUsd": 50,
                  "monthlyAlertThresholdUsd": 300, "monthlyBlockThresholdUsd": 500,
                  "alertSlackChannel": "C0123456789" } }
```

Sent whole — the object replaces what was stored, `null` clears the guards, and omitting the
field leaves them untouched. A partial merge would make "drop the block threshold, keep the
alert" unexpressible. Every threshold is optional and independent; within each window the
alert may not exceed the block (above it the alert could never fire on its own, because the
block stops the spending that would reach it).

Spend is the sum of every model's `costUsd` on the project's UTC-day usage rows — one row for
the daily window, the month's rows summed for the monthly one. Once a block threshold is
reached every execution entry point answers
`429 { "error": "Project \"…\" has reached its daily cost limit …" }` (or `monthly`) with
`Retry-After` set to the seconds until the window rolls over — 00:00 UTC for the day, the
first of the next month for the month. Crossing a threshold posts once per window to
`alertSlackChannel` using the project's own Slack bot; without a channel or bot the
thresholds still block. See [OPERATIONS.md](OPERATIONS.md#cost-guard--fails-open) for
what the guard does and does not bound.

### Versions & publish

```
GET|POST /api/projects/{name}/versions
GET|PUT|DELETE /api/projects/{name}/versions/{version} ({version} = a name or "published")
POST     /api/projects/{name}/publish   { "versionName": "3" }   → sets the published pointer
```

Version body: `systemPrompt`, `userPromptTemplate`, `model` (required, `provider/model`),
`fallbackModel?`, `parameters { temperature?, maxTokens?, reasoningEffort?, piiFiltering,
structuredOutput?, jsonSchema?, imageGeneration?, imageModel?, callerContext?,
dynamicCapabilities? }`,
`mcpList[{ name, headers?, tools? }]`, `skillList[]`,
`subagentList[{ name, type: "local"|"remote" }]`, `maxTurn?`. An `imageModel` that is not an
image-capable registry model is rejected with 400, as is a catalog `model` missing a capability
the version needs — `tools` for an `agent` project, `structuredOutput` for that parameter (an id
the catalog does not carry is warned about, not refused). `mcpList`/`skillList`/`subagentList`
entries must resolve to registered MCP servers, skills, agents, or projects — a dangling
reference is rejected with 400 — and only an `agent` project may carry them at all. On update
only *newly added* entries are checked, so a version stays editable after a registry entry it
already referenced is deleted. Naming the same server, skill or agent **twice** in one list is
rejected with 400 on every write, an update resubmitting a stored list included: a duplicate
binding opens the server's session twice and the second row silently overwrites the first
everywhere the run keys by name.

`callerContext` names the person asking in the system prompt, **on the surfaces that have
one**: the console chat and Playground, a session-authenticated run of `predict`, `agent` or
`chat/completions`, and Slack (which additionally supplies the caller's timezone from their
profile). A project **API token** carries no caller — it acts on the owner's behalf but nobody
is at the other end — and neither do trigger firings or inbound A2A. An image project is
unaffected: its prompt is the rendered template, with no system prompt for the block to live
in. `POST /api/projects/{name}/preview` shows the block exactly when a run from that page
would carry it.

`POST /api/projects/{name}/preview` takes an optional `message` — the request to preview
against, at most 8,000 characters. Only discovery reads it (an agent run's user turn comes from
the conversation), but *which* capabilities a run finds depends on what it is being asked, so
without one the preview shows the floor every run starts from rather than the shape of a
particular one.

`dynamicCapabilities` lets a run reach skills, MCP servers and agents this version never bound,
found by searching the global catalog with the version's system prompt and the request being
answered. It is **additive**: the bindings above are resolved first and in full, and nothing a
search finds can displace or truncate them. An MCP server that requires its own OAuth
connection is added only where the project has already authorized it; otherwise the run says so.
What was *found* is not a warning — a run logs it, and `POST /api/projects/{name}/preview`
returns it as `discovered`, separate from `warnings`. Without `VECTOR_BUCKET` the flag is stored
and the run says that too, rather than behaving as though the search found nothing. See
[ARCHITECTURE.md](ARCHITECTURE.md#capability-catalog).

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
- `X-Tenant-Id` is **reserved**. Every spelling of it is dropped after the merge and the calling
  project's name is stamped in its place, so no binding can name another project's tenant. See
  [SECURITY.md](SECURITY.md#what-an-mcp-server-is-told-about-the-caller).
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

Session-gated, like running a project. The draft's MCP bindings can attach chosen headers to a
registered server, but that is not an authority the gate could reserve — any signed-in user
binds the same registry server with the same headers from a project of their own. A masked
header resolves only against this project's stored binding for the same server name, so a
non-owner's preview sends nothing a run they may already start would not; and the assembled
text is composed of what `GET /versions` already answers with a session. The URL always comes
from the registry, so the SSRF surface is a run's.

## App settings

```
GET /api/settings → 200 { fields: { <key>: { value, source, secret } },
                          llmProviders: { source, items: [ { name, baseUrl, apiKey, keepModelPrefix } ] },
                          updatedAt? }
PUT /api/settings → 200 {…same shape…} | 400
```

- Admin-only (both verbs). Keys: `adminEmails`, `allowedEmailDomains`, `llmBaseUrl`,
  `llmApiKey`, `pluginsRepo`, `pluginsRepoBranch`, `githubToken`, `a2aApiKey`,
  `publicBaseUrl`, `unknownModelPolicy` (`allow` | `refuse` | `""`, the only key validated as
  an enum). `pluginsRepo` is the other key with a shape of its own — `owner/repo`, or empty to
  clear it; the rest are bounded strings.

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
  reveal leaves an audit row and a server-side log line naming the caller.
- `llmProviders` on PUT is a full replacement list (per-provider LLM channels); an empty
  array removes the override (`LLM_PROVIDER_*` env fallback). A masked `apiKey` keeps the
  currently effective key for that provider name. Provider `name` must be one of
  `openai | google | anthropic | xai`, the list holds at most 50 entries, and a name appearing
  twice is a `400`.
- `enabledModels` on PUT is also a full replacement list — the model ids `/api/models` may
  offer, stored sorted and deduplicated. An empty array removes the override (every visible
  model offered — there is no env fallback); an id the registry does not carry is a `400`. It
  has no slot in the GET view; `/api/models/catalog` is where it is read back.
- `source` is `override` (DB) | `env` | `default` | `unset`. Secret values are always masked
  (length-preserving; 9–20 chars reveal 2 at each end, 21+ reveal 4); a masked value on
  PUT keeps the stored secret, an empty string removes the override (env fallback). Setting `adminEmails` to a list that excludes
  the caller is rejected with `400`. So is an `adminEmails` or `allowedEmailDomains` value that
  is not empty but parses to no entries at all (`","`): removing the override is what the empty
  string is for, and reading that as the same thing would leave the deployment ungated.

## Audit trail

```
GET /api/audit?from=2026-08-01&to=2026-08-03
  → 200 { events: [ { eventId, actorEmail, action, target, detail?, createdAt } ] }
```

- Admin-only: the rows name people. `from` defaults to today, `to` to `from`; both are UTC
  days (`YYYY-MM-DD`). A range spans at most **31 days** — rows are stored one partition per
  day and read the same way, so the span is the query count. `400` on a malformed day, a day
  the calendar does not have (`2026-02-31`, `2026-13-01`), a reversed range, or one wider than
  that. The width is refused from the dates rather than from an enumerated range, so an absurd
  span costs the same as any other rejection.
- Newest first. `action` is one of `secret.reveal` | `secret.rotate` | `secret.revoke` |
  `project.admin-override` | `settings.update` | `project.delete` | `registry.delete` |
  `registry.adopt` (the plugins sync taking an entry another origin created); `target` is
  `kind:name`.
- **Read-only, by construction.** There is no write verb here or anywhere else — rows are
  appended by the acts themselves and expire by TTL (`AUDIT_RETENTION_DAYS`). `detail` never
  carries a credential: a settings write records which keys moved, never their values.

## Viewer

```
GET /api/me → 200 { email, isAdmin, isConfiguredAdmin, tier }
```

`tier` is the member's tier, so the console gates tier-scoped actions (creating a project)
through the same `tierMay*` predicates the routes enforce. Both flags are sent because they
answer different questions and the console needs both:
`isAdmin` (may mutate shared registries and app settings — an empty `ADMIN_EMAILS` means *no
restriction*) and `isConfiguredAdmin` (may write a project owned by someone else — an empty
list means *nobody*). Neither is derivable in the browser, and inferring one from the other is
what once offered every signed-in user an edit form that 403'd on save. See
[SECURITY.md](SECURITY.md#isadminemail-vs-isconfiguredadmin).

```
GET /api/me/profile
  → 200 { member: { id, name, email, image, tier, joinedAt, lastLoginAt },
          months: [ { email, month, calls, inputTokens, outputTokens, costUsd } ] }
```

The signed-in user's own member row and cross-project spend — always the session user, no
parameters. `months` is the six most recent UTC months, newest first; a month with no spend
(including months past the usage retention window) comes back zero-filled, so `months[0]` is
always the current month. Each metric is a map keyed by model id. The spend counted is the
member's own console runs (`user:` actors) — project-token runs spend against their project,
not this budget. What a tier caps is `TIER_LIMITS` in `src/domain/member/tiers.ts`, which
the client imports directly.

## Members

```
GET /api/members
  → 200 { members: [ { id, name, email, image, tier, joinedAt, lastLoginAt } ] }

PUT /api/members/{id}/tier
  { tier: "admin" | "member" | "guest" }
  → 200 { id, name, email, image, tier, joinedAt, lastLoginAt }
  → 400 unknown tier · 404 no such member
```

Admin-only. Members are Better Auth users who have signed in to the workspace, ordered by
`joinedAt` newest first. `lastLoginAt` is updated when a new session is created. It is `null`
for users created before login tracking was introduced until their next successful sign-in.

`tier` defaults to `guest` for every sign-up (rows written before tiers existed read as
`guest` too). A tier change writes a `member.set-tier` audit row recording old → new. What a
tier grants and caps is `TIER_LIMITS` in `src/domain/member/tiers.ts`; how tier `admin`
composes with `ADMIN_EMAILS` is in
[SECURITY.md](SECURITY.md#isadminemail-vs-isconfiguredadmin).

## Chats

Chats are private to their owner and run only against agent projects.

```
GET    /api/chats                            → { chats }
POST   /api/chats                            { projectName, firstMessage, images?, documents? } → SSE
GET    /api/chats/{chatId}                   → { chat, messages, activeRun? }
DELETE /api/chats/{chatId}                   → 204
POST   /api/chats/{chatId}/messages          { content, images?, documents? } → SSE
GET    /api/chats/{chatId}/runs/{runId}/stream → SSE
GET    /api/chats/{chatId}/runs/{runId}      → { active }
DELETE /api/chats/{chatId}/runs/{runId}      → { cancelled }
```

Both run streams open with a head frame — `{ chat?, runId, userSeq }`, carrying the new
`chatId` on a create — and close with `{ "ended": true }`. That last frame is the only thing
that distinguishes a finished run from a dropped connection; a body that simply stops looks
identical. The head frame is sent before the run produces anything, so the response commits
to `200 text/event-stream` immediately: the client always learns `chatId`/`runId` even when
the model's first token is a minute out, and a refusal raised by the run itself (the daily
cost guard, the concurrency guard) arrives as an `{error}` frame on that stream rather than
as a `429`. Streams otherwise use the standard SSE framing and persist user, assistant, tool,
and image display data. A project with neither a published version nor a runnable draft is
rejected with `400`.

**A run outlives the connection that started it.** Hanging up means the reader left, not
stop: the run finishes and persists either way. `GET /api/chats/{chatId}` reports
`activeRun: { runId }` while one is in flight, and
`GET /api/chats/{chatId}/runs/{runId}/stream` replays everything it has produced so far and
then follows it live — always from the start, so there is no cursor to keep. Note that a run
writes nothing down while a reader is attached, so a *second* viewer of the same run sees no
content until the first disconnects; the stream says so rather than appearing stalled.

`GET /api/chats/{chatId}/runs/{runId}` answers `{ active }` — whether that run still holds the
chat. It is what a reader asks after a stream ended without the `{ "ended": true }` frame:
reconnect, or take the answer from the conversation. `GET /api/chats/{chatId}` answers the
same question through `activeRun`, but ships the whole thread and signs every image in it on
the way, which is a lot to send to compare one id on a connection already known to be bad.

`DELETE /api/chats/{chatId}/runs/{runId}` is the only way to end a run early. It records the
request and answers `{ cancelled: true }`; `{ cancelled: false }` means the run had already
finished, which is not an error. Both run routes reject a `runId` that is not a UUID with
`400`. A stopped run ends like a finished one — what had streamed is persisted, the stream
closes with `{ "ended": true }`, and the reader gets a `warning` frame rather than an
`error`.

`images` are the user's attachments as inline bytes — `[ { b64, mimeType } ]`, at most 4 per
turn, 5MB each, `image/png|jpeg|gif|webp`. They reach the model as content parts and are
stored (when object storage is configured) as the **object key** on the user message; a read
answers with a URL signed for that response, never one that keeps working afterwards. An image
whose address cannot be minted is left out of the message rather than returned broken.

`documents` are files to read rather than look at — `[ { b64, mimeType, name } ]`, at most 4
per turn, 10MB each: PDF, plus text, Markdown, CSV/TSV, JSON, YAML, XML and HTML. `name` is
required and carries the decision when `mimeType` is `application/octet-stream`, which is how
uploads commonly arrive; an unreadable type is rejected with `400`. The server extracts the
**text** — a PDF's text layer, a text file's contents — and the turn carries that. The file
itself is never stored; the extracted text is, as `documents: [ { name, text, note? } ]` on
the user message, which is what lets a follow-up question still have the document. Up to
20,000 characters are kept per document and 40,000 across a turn; anything left out is
reported as a `warning`, as is a document that could not be read at all (a scan with no text
layer, a password-protected PDF).

A turn needs text or at least one attachment of either kind (all empty → `400`). Every route
that carries a turn — both chat routes, `predict`, `agent`, `chat/completions` and A2A — caps
the request body at the largest a legitimate turn can be (every attachment at its own limit
plus room for prose) and answers `413` above it, checked against the declared length before the
body is read rather than after it is in memory. Registry and version edits are bounded far more
tightly, by what a skill's whole file set weighs.

The chat read (`GET /api/chats/{chatId}`) returns each document's `name` and `note` with an
empty `text`: the extracted text is what a *later turn* replays, read server-side, and
shipping it to the browser would put tens of thousands of characters per turn on the wire for
a view that renders neither.

## Registry and integration operations

These endpoints support the console's operational actions in addition to resource CRUD:

```
GET  /api/plugins
→ [ { name, version?, description?, repo, rootPath, commitSha,
      skills: ["name"], mcpServers: ["name"], syncedAt, createdAt, updatedAt } ]

GET  /api/plugins/{name}
→ 200 { …one of the above… } | 404 | 400   ({name} follows the Agent Plugins name rule,
                                            which allows periods — not the registry slug)

GET  /api/plugins/sync
→ { configured, repo, branch,
    last: { repo, report, actorEmail, finishedAt } | null }   (the persisted last report)

POST /api/plugins/sync
→ the sync report described below | 400 (malformed removal selection; each list holds at
  most 500 names) | 409 (a sync is already running) | 503 (not configured)

POST /api/plugins/sync/scan          (X-Scan-Token: SCHEDULE_SCAN_TOKEN)
→ 202 { started } | 200 { upToDate } | 401 | 503
```

`/sync/scan` is the CronJob tick: it compares the branch head against the last report and
answers `upToDate` without paying for a snapshot when nothing merged (unless that report
carried a `write-failed` skip — only a re-run repairs one). A tick syncs as `scheduler`,
never deletes (removal selections exist only in the console), and shares the schedule
ticker's token — one CronJob credential per deployment.

```

POST /api/mcps/{name}/tools
→ { tools } | 502 (connection failure)

POST /api/agents/{name}/message   { "message": "hello" }
→ { text } | 502 (remote failure)

GET /api/projects/{name}/a2a
→ { enabled, published, cardUrl, card }
```

`card` is the Agent Card the project publishes, or `null` while no version is published.

The sync endpoint answers `GET` to a session and requires admin access for `POST`. Registry
test operations require a session and apply the same SSRF guard used during registration and
dispatch. Plugins have no create/update routes: the sync is their only writer, and a plugin
row goes away through the sync's own `remove` selection.

The sync follows one rule: **the repository owns what it declared; a person owns deletion.**
The removal selection is kind-qualified, because the skill and MCP registries may hold the
same name:

```
POST /api/plugins/sync  { "remove"?: { "skills"?: ["name"], "mcpServers"?: ["name"],
                                       "plugins"?: ["name"] } }
→ 200 { repo, commitSha,
        plugins: [ { plugin, version?, description?,
                     skills:     { created, overwritten: [{name, fields}], unchanged,
                                   orphaned: [{name, boundTo}], removed, skipped },
                     mcpServers: { …same shape… } } ],
        skipped, orphanedPlugins, removedPlugins }
```

Per kind, in each plugin's section:

- **created** — in the repository, not in the registry. Imported outright, with
  `source: "github:<repo>#<plugin>"`.
- **overwritten** — in both and differing; brought to the repository's version
  **automatically**, with `fields` naming what moved. `source` among them is an adoption: an
  entry created by another origin (the retired skills/tools repos, a different plugin) — or
  by hand, with no source at all — changed hands, which also leaves a `registry.adopt`
  audit row. A console edit to a name the repo declares is replaced on the next sync — the
  repo is the source of truth. A hand-registered entry whose name no plugin declares is
  never touched. **Credentials never follow an address**: a URL move drops the entry's
  stored headers and OAuth block (reported as `credentials-reset`) rather than send the old
  host's secrets wherever the repository now points.
- **unchanged** — in both and already in agreement; nothing was written, so `updatedAt` does
  not move.
- **orphaned** — created by a sync of this repository and no longer declared by any plugin in
  it, attributed to the plugin its source names (a section is synthesized for one that
  vanished entirely), with `boundTo` listing the `project/version` bindings that would
  dangle. **Nothing is deleted** unless the name is in the matching `remove` list — an MCP
  entry holds credentials, and a file disappearing from a branch is not reason enough to
  destroy them. An unreadable `plugin.json`/`mcp.json` orphans nothing: the plugin freezes
  at its last good state until the file parses again. Deleting a managed entry routes
  through the managed use case so the container stops with the row; a deletion leaves a
  `registry.delete` audit row naming the admin who asked, exactly as from the console.
- **skipped** — `[{ name, reason, detail? }]` with `reason` one of `bad-name`, `invalid-url`
  (the outbound guard's message in `detail`), `managed-url` (a managed MCP entry's address
  comes from the provisioner, so the document's was ignored while its other fields applied),
  `conflict` (a mid-sync race, either direction), `attachment` (a skill synced but one of
  its files did not), `invalid-manifest` (an unusable `mcp.json`, or an unusable server
  entry inside one), `invalid-skill` (a SKILL.md outside the Agent Skills spec),
  `unsupported-transport` (`stdio`/`sse` — reported, never executed), `headers-dropped` (the
  server synced but mcp.json's declared headers were not imported; `detail` lists their
  names only), `duplicate-name` (two plugins claim the name; every claimant is skipped),
  `credentials-reset` (see above), `write-failed` (one write was fenced off; the rest of the
  sync continued and the next run converges).

The top-level `skipped` carries what no plugin owns — an unusable `plugin.json`, a plugin
root nested inside another, a plugin name two roots claim. `orphanedPlugins` lists plugin
rows the repository no longer carries; removing one (via `remove.plugins`) deletes only the
row — its components surface individually as orphans, each its own decision.

A write replaces only what the documents own — a skill's description, content and
attachments; an MCP entry's `url`, `description`, `content` (from the plugin's
`org.opspresso.agentdure/mcp/<name>.md` extension document) and `source`. Encrypted
headers, a discovered OAuth block and a managed entry's provisioned address are never
touched, and a field the documents do not carry leaves the stored one alone. Moving an MCP
entry's address drops the OAuth block read from the old one, so Discover has to be re-run.

An upstream failure (GitHub unreachable, a truncated tree) answers `502` through `apiError`
like every other route; a missing `PLUGINS_REPO` or `GITHUB_TOKEN` answers `503`.

Per-project Slack configuration uses these endpoints:

```
GET    /api/projects/{name}/slack
PUT    /api/projects/{name}/slack   { botToken?, signingSecret?, enabled?, suggestedPrompts? }
DELETE /api/projects/{name}/slack
POST   /api/projects/{name}/slack/test
```

`suggestedPrompts` is `{ title, message }[]`, at most four, with `title` capped at 80 characters
and `message` at 500; blank rows are dropped and a row with only one half — or one over either
cap — is a 400. Unlike the two credentials it is not a secret and comes back as stored.

Slack reads return masked credential state plus `configured`, `eventsPath`, `eventsUrl`,
`suggestedPrompts` and a generated app manifest — every verb answers that same view.
All four endpoints are limited to the owner and to configured admins (403 for anyone else) — the masked view still exposes the
bot token / signing secret edges. Masked or omitted secrets are preserved on update, and a
`PUT` on a non-agent project is a 400 — a Slack bot only attaches to an agent project. So is a
`PUT` sending `enabled: true` with neither a stored nor a supplied bot token and signing
secret: there is nothing to enable. The
test endpoint returns `{ ok: true, team, botUser }`, `400` when Slack is unconfigured or
disabled for the project, or `502` for a Slack API failure.

## Managed MCP servers

A managed server is a container this deployment starts on its own host through SSM Run
Command and reaches on loopback. All four endpoints are **admin-only**, and all four answer
`503 { "error": "This deployment is not configured to run managed MCP servers." }` when
`MANAGED_MCP_INSTANCE_ID` / `MANAGED_MCP_REGISTRY` are unset — the feature is off rather than
half-enabled.

```
POST   /api/mcps/managed              → 201 { …registry entry… }   | 409 | 400 | 503
GET    /api/mcps/managed/{name}       → 200 { name, image?, running, reachable, address?, detail? }
PUT    /api/mcps/managed/{name}       → 200 { …entry… }            | 404 | 409 | 400 | 403
DELETE /api/mcps/managed/{name}       → 204                        | 404 | 403
POST   /api/mcps/managed/{name}/restart → 202 (no body)            | 404 | 400 | 409 (restart in flight)
```

Create body:

```json
{ "name": "my-tool", "image": "…/my-mcp:1.4.0", "containerPort": 8080,
  "args": ["--port", "{{PORT}}"]?, "endpointPath": "/mcp"?,
  "environment": { "LOG_LEVEL": "info" }?, "envRefs": ["/agentdure/my-tool/API_KEY"]?,
  "description": ""?, "content": ""?, "headers": {}? }
```

- `name` is a slug (`^[a-z0-9][a-z0-9-]{0,62}$`) because it is also the container's name.
- `args` is an **argv array**, never a shell command; at most 64 entries, each ≤1024 chars and
  free of control characters. `{{PORT}}` in an argument is substituted with the effective
  listen port, for images that do not honour the `PORT` environment variable.
- `environment` values are encrypted in the registry row, masked on reads, and decrypted only
  when building the workload spec. `PORT` is rejected — the runtime owns it. Use `envRefs`
  when the value should stay in Parameter Store instead. Keys are `^[A-Za-z_][A-Za-z0-9_]*$`
  and values run to 16,384 characters.
- `endpointPath` defaults to `/mcp` and must be an absolute path with no query, fragment or
  whitespace (`^\/(?!\/)[^\s?#]*$`); anything else is a `400`.
- The `403` on `PUT`/`DELETE` is the repo-owned refusal every registry route answers: a synced
  entry's `description` and `content` belong to the repository, while its workload fields
  (`image`, ports, env) stay editable here.
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
→ 200 { authorizeUrl: "https://provider/authorize?…" }

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
- A registry entry with no `auth` block has nothing to connect to, so `PUT` and `/authorize`
  answer `400`; `/authorize` also `400`s with no public base URL configured, when the server
  offers no dynamic registration and no client was entered by hand, and when the stored
  credentials were issued by a different issuer than the entry now names. `DELETE` answers
  `404` when the project has no connection to that server; `/tools` needs no connection to
  run, and its `404` means the registry entry itself is gone.
- `/tools` lists the server's tools **as this project sees them** — with the project's own
  connection and the binding's header overlay. Distinct from the registry's own
  `POST /api/mcps/{name}/tools` probe, which carries only the entry's static headers and can
  do nothing but 401 against an OAuth server. Owner-gated for the same reason: it spends the
  project's connection. Its `502` also covers the two refusals that never reach the server — a
  URL the outbound guard blocks, and a connection whose credential cannot be resolved.

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

Generation is additionally gated on the **owner's tier**: a tier that may not use API
tokens (`TIER_LIMITS` in `src/domain/member/tiers.ts` — today `guest`) answers `403`
whoever asks, admin included, because the token would authenticate as that owner. The
matching gate at authentication time is on the execution endpoints below.

`/reveal` is a POST although it reads: the body is a live credential, so it stays out of
caches, history and prefetches. `revealable` is `false` for a token issued before encrypted
storage — only its hash exists, so `/reveal` answers `400` with instructions to regenerate.
Verification accepts both forms (decrypt-and-compare in constant time, or hash comparison
for a legacy token). Every reveal is logged server-side with the caller's email.

## Execution

The three endpoints below authenticate with either the session cookie or a project API
token (`Authorization: Bearer <token>`). A token authenticates as the project owner; a
valid token whose owner's *current* tier may not use API tokens answers `403` (not `401` —
the credential is valid, the policy refuses it), so demoting an owner immediately stops
their tokens.

All three are bounded by `MAX_RUN_DURATION_MS`, the per-caller concurrency guard, and the
project's daily cost guard — any of which answers `429` with `Retry-After`. A session run
is additionally bounded by the caller's tier (concurrency and monthly cost cap); a token
run is not — token spend belongs to the project, never to a personal budget.

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
  "finishReason": "completed",  // why the run ended: "turn-limit" / "output-limit" mark a partial answer
  "warnings": [ "Skill 'x' is no longer in the registry; it was not offered." ]?,  // only when the run lost something
  "images": [ { "b64": "…", "mimeType": "image/png" } ]?  // only when the run drew something
}
```

`warnings` is what the run reported losing on the way to that answer — a binding no
longer in the registry, an MCP server the outbound guard blocked, tools past the per-run
cap, a clipped transfer transcript, a subagent that came back empty. A streamed run says
each of these in a `warning` frame as it happens; a collected body has no later frame, so
they travel with the answer. Absent means nothing was lost.

For an `image` project, send `{ "prompt", "size?", "quality?", "images?" }` → `{ imageBase64,
mimeType, model, usage }`. `images` are source pictures as inline bytes
(`[ { b64, mimeType } ]`, same caps as a chat attachment): with any present the prompt
**edits** them, with none it draws from scratch. The version's system prompt, when set, is
prepended to the prompt as the version's persistent style.
With `"stream": true`, the response is SSE.

A run this endpoint could not finish answers `502` with what the provider said and the model
it was asked of — `Image generation failed for xai/grok-imagine-image: 404 The requested
resource was not found.` A collected body is the one execution surface with no `error` frame
to carry that, so before it was typed the same failure arrived as `500 Internal server error`
and a version naming a model its provider does not serve was indistinguishable from a crash.

### `POST /api/projects/{name}/versions/{version}/chat/completions`

OpenAI Chat Completions-compatible. `agent` projects run the multi-turn tool loop; `llm`
projects do a single completion. An `image` project is refused with `400` — an image has no
chat completion; run it through `/predict`.

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

**What the run lost.** Same treatment, same reason: `warnings: [ "…" ]` on the completion
object and `choices[0].delta.warnings` frames in a stream. These are the losses a run
reports as it goes (see `/predict` above); without them a degraded run and a clean one are
the same response on this surface.

### `POST /api/projects/{name}/versions/{version}/agent`

Agent SSE stream. Body `{ "messages": [ … ] }`. Emits `EngineChunk` frames
(`delta.content`, `toolResult`, `warning`, `image`, `author` for subagent turns, `error`,
and a terminal `done: true` or `finishReason` naming why the run ended) then
`data: [DONE]`. The full field contract is in
[ARCHITECTURE.md](ARCHITECTURE.md#enginechunk-contract).

**Agent projects only** — 400 for any other type. The tool loop has nowhere to put an
`llm` project's `userPromptTemplate`, and an `image` project's model does not serve
completions; use `/predict` for either.

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
person's own runs — and only the `user:` rows count toward a personal tier budget),
`slack:U123`, `a2a:shared-key`, and for a trigger firing
`webhook:{project}:{triggerId}` or `schedule:{project}:{triggerId}`. The metric fields are
per-model maps, exactly as in the summary above.

`display` puts a face on a `slack:` row, resolved through the project's own bot token. It is
decoration and may be absent for any reason — no Slack bot, a revoked token, a deactivated user,
a Slack outage — and `actor` is unchanged in every case, because that is the key two callers are
told apart by.

Owner/admin only, on the same reasoning as traces: project *totals* are open to any
signed-in user because the catalog is shared, but a breakdown by caller names individuals.
Range validation matches `/api/usages/summary` (both dates required, `from ≤ to`, ≤ 184
days), though a refusal here is a bare `{ error }` rather than the `issues` array the other
range endpoints carry. Subagent transfers are attributed to whoever started the run, not to
the project they transferred into.

## Triggers

Configuration (owner/admin):

```
GET    /api/projects/{name}/triggers                     → 200 { triggers: [ … ] }
POST   /api/projects/{name}/triggers                     → 201 { …, secret? }  | 409
PUT    /api/projects/{name}/triggers/{trigger}           → 200 { … }           | 404
DELETE /api/projects/{name}/triggers/{trigger}           → 204                 | 404
POST   /api/projects/{name}/triggers/{trigger}/reveal    → 200 { secret, createdAt }
GET    /api/projects/{name}/triggers/{trigger}/runs?limit=20 → 200 { runs: [ … ] }   (1–100)
```

Create body: `{ triggerId (slug), kind?, description?, enabled?, variables?, payloadMode?,
allowConcurrent?, cron?, timezone?, message? }`. `kind` defaults to `webhook`; a `schedule`
requires `cron` (five fields) and `timezone` (IANA), and each kind refuses the other's fields
with 400 rather than ignoring them — `rotateSecret`/`payloadMode` belong to webhooks,
`cron`/`timezone`/`message` to schedules. `triggerId` follows the same rule as a project name
(`^[a-z0-9-]+$`); the console normalises what you type through the same `toSlug` helper the
project form uses, and the API rejects anything else regardless of client.

Ordinary reads return `secretMasked` only (webhooks; a schedule has no secret). The secret is
stored AES-encrypted rather than hashed, so — exactly like a project API token — it can be
**read back** through `POST …/reveal` (a POST because the body is a live credential;
owner/admin only, and every reveal is logged with the caller's email). `PUT` with
`rotateSecret: true` re-issues it and returns the new one; the previous secret stops working
immediately.

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
in the response. A trigger always runs the project's **published** version. A `succeeded` row
may carry a `warning` — what the run reported without failing (a turn or budget limit it hit,
a binding it could not use): a firing is unattended, and the row is its only channel for it.

`payloadMode: "message"` (the default) serialises the payload into the user turn — what an
agent project reads. `"variables"` flattens the payload's scalar top-level fields over the
trigger's fixed `variables` for a prompt template; non-scalar fields are dropped rather than
rendered as `[object Object]`.

`allowConcurrent` is false by default: a second delivery while one is still running is
recorded as `skipped` rather than piling runs up.

Scheduler tick (no session — the shared token is the authentication):

```
POST /api/triggers/scan
  X-Scan-Token: <SCHEDULE_SCAN_TOKEN>
→ 200 { checked, fired, alreadyClaimed, skipped, repaired, invalid, errors }
→ 401 (wrong or missing token) | 503 (SCHEDULE_SCAN_TOKEN not configured)
```

What a Kubernetes CronJob calls once a minute. The ticker holds no state: which occurrences
are due and who wins each one is decided server-side, per occurrence, with a conditional
write — so ticking twice, from several places, or late never double-fires. Admitted firings
run in the background exactly like webhook deliveries; their outcomes land on the trigger's
history rows (`scheduledFor` carries the occurrence). `alreadyClaimed` counts occurrences
another tick had already won — expected noise from overlapping windows, not an anomaly. The
same summary is logged server-side on every tick, which is what an operator alerts on.

Catalog reindex (same shared token, a separate CronJob):

```
POST /api/catalog/reindex
  X-Scan-Token: <SCHEDULE_SCAN_TOKEN>
→ 200 { started: true }
→ 401 (wrong or missing token)
→ 503 (SCHEDULE_SCAN_TOKEN not configured — answered before the token is compared, so a
       deployment missing it gets this rather than a 401) | 503 (VECTOR_BUCKET not configured)
```

Rebuilds the global capability index from the registries — every skill, every MCP server and
the tools it offers, every external agent — and deletes what they no longer have. The work runs
in the background, so the outcome is a log line (`indexed`, `removed`, `undiscovered`) rather
than the response body. Ticking twice is safe: keys are derived from the entry, so a second
pass writes the same records. Hourly is ample — a faster tick only probes every MCP server more
often. See [OPERATIONS.md](OPERATIONS.md#catalog-reindex).

## Artifacts

What runs produced — images and documents — with an address for each. Present only when
`S3_BUCKET_NAME` is configured; every route below answers `404 {error}` otherwise, rather than
an empty list, because "you have made nothing" is a different claim from "nothing was ever
being kept".

```
GET /api/artifacts?[kind=image|document][&source=generated|attachment][&limit=24][&before=…][&from=2026-08-01&to=2026-08-12]
→ 200 { artifacts: [ … ], nextBefore?: "2026-08-11T22:03:00.000Z#8f0c…" } | 400 | 404
GET /api/projects/{name}/artifacts?…same query…
→ 200 { artifacts: [ … ], nextBefore?: … } | 400 | 403 | 404
DELETE /api/artifacts/{artifactId}
→ 204 | 403 | 404
```

Each row carries `artifactId`, `kind`, `source`, `mimeType`, `byteSize`, `filename?`,
`projectName`, `versionName`, `actor?`, `producedBy?`, `runId?`, `prompt?`, `createdAt`, and a
signed `url` (15 minutes; a document's is signed to download under its own name). The URL is
inlined rather than fetched per tile — pre-signing is a local signature, so a page of them
costs nothing while a round trip each would make a gallery N+1. It is absent when the address
could not be minted, and the UI renders that as unavailable rather than a broken image.

**The two listings are not two views of one set.** `/api/artifacts` reads the owner index,
which only holds rows whose actor names an email — a Slack, A2A, webhook or schedule run does
not. Those are reachable only through their project, which is therefore the only place they can
be deleted from. `from`/`to` are UTC days validated as real dates; `before` is the previous
page's `nextBefore`.

Deletion is permitted to the creator, to the project's owner, and to configured admins.
Removing someone else's output records an `artifact.delete` audit row; removing your own does
not. A chat message keeps its own copy of the object key, so an image deleted here renders as
unavailable in the transcript that showed it — the confirmation says so before the fact.

## Traces

```
GET /api/projects/{name}/traces?limit=50[&from=2026-07-01&to=2026-07-31]
→ 200 { traces: [ … ] } | 400
GET /api/projects/{name}/traces/{traceId}
→ 200 { …the trace itself, unwrapped… } | 404
```

`from`/`to` (YYYY-MM-DD, inclusive) filter the list by trace date via the GSI1 date key; a
malformed day or a reversed range is a `400`. `limit` defaults to 50 and is clamped to 1–100.
A `traceId` that belongs to another project is a `404`, not someone else's trace.

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
providers' models are listed; with none configured every model is listed. An `enabledModels`
settings override (managed on the `/models` console page) then narrows the list to the ids it
names. Enabled is a selection-time filter only: a version already holding a disabled model
keeps running.

```
GET  /api/models/catalog → 200 { providers: [ { name, available, dedicated } ],
                                 models: [ { …model, enabled } ],
                                 source: "override" | "default" }
POST /api/models/test    → 200 { ok, latencyMs, error? } | 400
```

- Both admin-only. `catalog` is the unfiltered picture behind `/models`: every visible model
  with its enabled flag (it lists exactly what `/api/models` hides), and per provider whether
  this deployment can dispatch to it — `dedicated` means a per-provider channel is configured;
  with none, every provider is `available` through the default channel.
- `test` sends one tiny completion (`maxTokens` 16, 15s timeout) through the real channel —
  provider resolution, base URL, API key and wire-id rewriting included. A failed probe is the
  `200` body (`ok: false` with the upstream error), not a `5xx`; only an id the registry does
  not carry is a `400`. The probe runs outside the run bracket, so it records no usage row.

## A2A (inbound)

Enabled by `A2A_API_KEY`, or by at least one named client key with no shared key at all. Each
project with a published version then serves a public Agent Card and a JSON-RPC endpoint.

```
GET  /api/a2a                                           (session) → { enabled, projects }
GET  /api/a2a/{project}/.well-known/agent-card.json     (public)
POST /api/a2a/{project}     X-A2A-Key: <key>            (JSON-RPC: message/send, message/stream,
                                                         tasks/get, tasks/cancel)
```

`GET /api/a2a` lists the published projects exposed over A2A: `enabled` reports whether the
surface is on — a shared `A2A_API_KEY` or at least one named client key — and each project
entry carries `{ name, displayName, description, cardUrl }`.

`503` (not configured) answers only when the surface is off entirely: no shared key **and**
no client keys. On an enabled surface a wrong or missing key is `401` — the shared key
compares in constant time, a client key resolves by hash.

The presented key may be the shared `A2A_API_KEY` (runs attributed to `a2a:shared-key`) or a
**named client key** (`asc_…`, runs attributed to `a2a:{client}` — per-client attribution and
concurrency limits). Client keys are admin-managed:

```
GET    /api/settings/a2a-keys                  (admin) → { items: [{ name, description?, masked, createdAt }] }
POST   /api/settings/a2a-keys                  (admin) { name, description? } → { key, view }   key shown once
DELETE /api/settings/a2a-keys/{name}           (admin) → { ok: true } | 404                     revoke
POST   /api/settings/a2a-keys/{name}/reveal    (admin) → { key, createdAt }                     audited
```

A client key's `name` is a slug of at most 64 characters and `shared-key` is reserved for the
app-wide key, each a `400`; a name already issued is a `409`.

Agent Card URLs are built from `PUBLIC_BASE_URL`. Task state (`message/send` →
`tasks/get`/`tasks/cancel`) is persisted per project in DynamoDB, so it survives redeploys and
is shared across instances; a terminal-state-guarding conditional write keeps a concurrent
complete/cancel from regressing a finished task. Rows expire via TTL
(`A2A_TASK_RETENTION_DAYS`, default 1 day).

## Platform endpoints

```
GET /api/health   → 200 (static)
GET /api/ready    → 200 { ready: true, checks: { db, llm } }
                  | 503 { ready: false, draining: true }          (after SIGTERM)
                  | 503 { ready: false, checks: { db, llm } }     ("ok" | "unreachable" each)
GET /api/metrics  → 200 text/plain; version=0.0.4
```

`/api/health` is liveness — a static 200 answering "is the process serving", dependency-free
so a downstream blip does not trigger a restart. `/api/ready` is readiness — it probes
DynamoDB and the LLM channel (short timeout, details not surfaced) and returns 503 when a
downstream is unreachable or the instance is draining after SIGTERM.

`/api/metrics` is a Prometheus scrape exposing `agentdure_active_runs`,
`agentdure_runs_{started,finished,failed}_total`, `agentdure_run_duration_seconds`,
`agentdure_unknown_model_calls_total`, `agentdure_unknown_models` and
`agentdure_draining`. No metric is labelled by project, user or model.

All three are unauthenticated and dependency-light on purpose — they are probed by
infrastructure that has no session. See [OPERATIONS.md](OPERATIONS.md#health-probes) for how
to wire them.
