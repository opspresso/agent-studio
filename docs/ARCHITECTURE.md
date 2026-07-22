# Agent Studio Architecture

Agent Studio is a production-level single Next.js 16 full-stack application. It covers the domains: **project, llm, agents
(subagents + external agent registry), skills, mcp, chat, cost/usage**.

## Stack

- Node.js 22, pnpm 11 (`packageManager` pinned)
- Next.js 16 App Router, React 19, TypeScript strict
- Tailwind CSS v4 (CSS-first config via `@import "tailwindcss"` — no tailwind.config file)
- Better Auth 1.6 + Google OAuth (custom DynamoDB adapter)
- AWS DynamoDB Single Table Design

## Clean Architecture Layers

```
src/
  domain/           # Entities + repository ports. Pure TS. No framework/AWS imports.
    project/  llm/  chat/  skill/  mcp/  agent/  usage/
  application/      # Use cases. Depends on domain ports only.
  infrastructure/   # Adapters: DynamoDB repositories, LLM provider client, MCP client.
    db/             # Single-table client, key builders, repositories
    llm/            # OpenAI-compatible provider channel, streaming
    mcp/            # MCP HTTP client
  app/              # Next.js App Router: pages + route handlers (presentation)
    api/            # Route handlers call application use cases, never repositories directly
  components/       # Shared React components
  lib/              # auth, session helpers, config
```

Dependency rule: `app → application → domain ← infrastructure`. Route handlers and pages must
not import from `infrastructure/` directly except through the composition root
(`src/lib/container.ts`), which wires ports to adapters.

## DynamoDB Single Table Design

One table (env `DYNAMODB_TABLE_NAME`, default `agent-studio`), keys `PK` (S) / `SK` (S),
GSIs: `GSI1` (`GSI1PK`/`GSI1SK`), `GSI2` (`GSI2PK`/`GSI2SK`). All items carry `entityType`.

| Entity | PK | SK | GSI1PK | GSI1SK |
|---|---|---|---|---|
| Auth (better-auth model rows) | `AUTH#{model}#{id}` | `ITEM` | `AUTH#{model}` | `{id}` |
| Auth unique lookup (email, token, ...) | — | — | GSI2: `AUTH#{model}#{field}#{value}` | `ITEM` |
| Project | `PROJECT#{name}` | `META` | `TYPE#PROJECT` | `{name}` |
| Project version | `PROJECT#{name}` | `VERSION#{versionName}` | — | — |
| Chat | `CHAT#{chatId}` | `META` | `CHATOWNER#{email}` | `{updatedAt ISO}` |
| Chat message | `CHAT#{chatId}` | `MSG#{seq zero-padded 6}` | — | — |
| Skill | `SKILL#{name}` | `META` | `TYPE#SKILL` | `{name}` |
| MCP server | `MCP#{name}` | `META` | `TYPE#MCP` | `{name}` |
| External agent (registry) | `AGENT#{name}` | `META` | `TYPE#AGENT` | `{name}` |
| Usage (daily per project) | `USAGE#{projectName}` | `DATE#{yyyy-MM-dd}` | `USAGEDATE#{yyyy-MM-dd}` | `{projectName}` |
| Trace | `TRACE#{traceId}` | `META` | `TRACEPROJECT#{projectName}` | `{createdAt ISO}` |

Conventions:
- Published version is a pointer attribute `publishedVersion` on the project `META` item, not a copy.
- Usage rows are updated with atomic `ADD` per model: `calls.{model}`, `inputTokens.{model}`,
  `outputTokens.{model}`, `costUsd.{model}` (DynamoDB map with ADD on nested number attrs — use
  `UpdateExpression` `ADD #calls.#model :one`).
- Key builders live in `src/infrastructure/db/keys.ts` — never hand-write key strings elsewhere.
- Reserved words (`name`, `owner`, `timestamp`) always via `ExpressionAttributeNames`.
- List queries paginate through `queryAll()` (`src/infrastructure/db/query.ts`); a Query page
  caps at 1MB, so an unpaginated list silently truncates. `traceRepository` is the one
  intentional exception (bounded top-N by `Limit`).

## Domain Semantics

### Project / Version
- `Project { name (slug, immutable id), displayName, description,
  projectType: 'llm' | 'agent' | 'image', ownerEmail, departmentCode?,
  publishedVersion?, createdAt, updatedAt }`
- `Version { versionName, systemPrompt, userPromptTemplate, model, fallbackModel?, parameters
  (temperature, maxTokens, reasoningEffort?, piiFiltering, structuredOutput?/jsonSchema),
  mcpList: string[], skillList: string[], subagentList: {name, type:'local'|'remote'}[],
  maxTurn?, createdAt }`
- Template variables `{{var}}` rendered server-side before dispatch.

### LLM Engine (`src/application/llm/engine.ts` — public contract)
- All text generation goes through a single OpenAI-compatible channel
  (`openai` SDK pointed at `LLM_BASE_URL`; model ids like `openai/gpt-5-mini`,
  `google/gemini-3.1-flash-lite`, `anthropic/claude-sonnet-4.6`). No per-provider clients.
- `runPrompt(input): Promise<RunResult>` — single-shot; supports streaming via
  `runPromptStream(input): AsyncGenerator<EngineChunk>`.
- `runAgent(input): AsyncGenerator<EngineChunk>` — recursive multi-turn tool loop:
  - turn guard `currentTurn >= maxTurn` (default 50) stops the loop
  - all tool_calls of one response aggregate into ONE assistant message, then tool results
    append, then recurse with `turn + 1`
  - builtin tools intercepted before MCP dispatch: `Skill` (progressive skill loading),
    `transfer_to_agent` (subagent transfer — local recursion or remote agent HTTP call;
    budget guard `turn + 2 >= maxTurn` rejects transfer)
  - subagent transfer passes ONLY the model-written `message` (no parent history);
    child's final text returns as a "For context: ..." user message
  - stream chunks carry optional top-level `author` when subagents are wired
- Fallback: on 429/5xx from primary model, retry once with `fallbackModel`.
- Cost: after each call, `recordUsage` computes cost from the model registry pricing and
  atomically ADDs into the usage row; multi-turn agent runs accumulate.
- Model registry `src/domain/llm/models.ts`: `ModelConfig { id, provider, displayName,
  pricing { inputPer1M, outputPer1M, cachedInputPer1M? }, capabilities { tools,
  structuredOutput, imageInput, reasoning }, contextWindow, maxTokens, hidden? }`.

### Skills
- Skill = markdown behavior instructions (progressive disclosure): system prompt lists
  name+description table only; model calls builtin `Skill` tool to load full content.
- Stored in table: `Skill { name, description, content (markdown), createdAt, updatedAt }`.

### MCP
- `McpServer { name, url, description?, headers: Record<string,string> (values encrypted
  at rest AES-256-GCM `enc:v1:` prefix, masked with length-preserving asterisks on read), createdAt, updatedAt }`
- `url` is SSRF-guarded (`src/infrastructure/net/ssrfGuard.ts`) at registration and dispatch:
  non-http(s) schemes and private/loopback/link-local/metadata addresses are rejected.
- Tool loading via MCP streamable HTTP (`tools/list`, `tools/call` JSON-RPC). Tool name
  collisions get `_1/_2` suffix aliases with reverse mapping. Tool results capped at
  100,000 chars.

### External Agents (registry, A2A-lite)
- `ExternalAgent { name, url (OpenAI-compatible or agent endpoint), protocol ('openai' |
  'a2a'), description, headers (encrypted like MCP), createdAt }` — usable as `type:'remote'`
  subagents. `url` is SSRF-guarded like MCP.

### Chat
- `Chat { chatId, title, ownerEmail, projectName?, createdAt, updatedAt }`,
  messages append-only with `seq`. Chat execution uses the agent engine directly
  (no HTTP self-call), streams SSE to the client.

### Usage / Cost
- Daily per-project per-model aggregates (see table design). Dashboard reads
  `USAGEDATE#{date}` GSI partitions across a range and regroups client-side by
  project/provider/model.

## API Surface (App Router route handlers)

Request/response shapes, auth, and error cases: see [API.md](API.md).

```
POST /api/projects                          create
GET  /api/projects                          list
GET|PUT|DELETE /api/projects/[name]
GET|POST /api/projects/[name]/versions
GET|PUT  /api/projects/[name]/versions/[version]
POST /api/projects/[name]/publish           set publishedVersion
POST /api/projects/[name]/versions/[version]/predict        (version = name | 'published')
POST /api/projects/[name]/versions/[version]/chat/completions   OpenAI-compatible
POST /api/projects/[name]/versions/[version]/agent          SSE stream
GET|POST /api/skills, /api/mcps, /api/agents (+ [name] GET|PUT|DELETE)
GET|POST /api/chats, GET|POST /api/chats/[chatId]/messages  (POST streams SSE)
GET  /api/usages/summary?from&to
GET  /api/models
```

All routes require a Better Auth session except the unauthenticated webhooks
(`/api/health`, `/api/slack/events/*` verified by signing secret, `/api/a2a/*` gated by
`A2A_API_KEY`). Projects are a shared catalog: any signed-in user may read and run any
project, but mutations (update/delete/publish, version create/update, Slack config) are
owner-only — `assertProjectOwner` returns 403 for non-owners. MCP/agent/skill registries
are shared: reads are open to any signed-in user, while mutations go through
`withAdminAuth` and are restricted to `ADMIN_EMAILS` when set (unset allows any
signed-in user). SSE responses use
`text/event-stream` with `data: {json}\n\n` framing and a terminal `data: [DONE]`.

## Auth

Better Auth 1.6, Google OAuth only, custom DynamoDB adapter over the single table
(`src/lib/auth-adapter.ts`). Session read helper `getSessionUser()` in `src/lib/session.ts`;
route handlers wrap themselves in `withAuth(...)`, which returns a 401 `Response` when
there is no session and otherwise passes the `SessionUser` as the handler's first argument.

## UI Pages

```
/                     redirect → /projects
/projects             project catalog (cards)
/projects/[name]      orchestration playground (prompt editor, model picker, run/stream)
/projects/[name]/versions | settings | usage
/chats  /chats/[chatId]
/skills  /tools (MCP)  /agents
/dashboard            cost dashboard (range picker, group by project/provider/model)
```

UI text in English. Tailwind v4 utilities only — no inline styles.

## Environment

See `.env.example`. `STAGE` = local | alpha | prod. Local DynamoDB via
`DYNAMODB_ENDPOINT_URL=http://localhost:8000`; `scripts/init-local-table.ts` creates the
table + GSIs.

## Verification

- `pnpm typecheck` (tsc --noEmit, strict) and `pnpm build` must pass.
- `pnpm test` runs Vitest unit tests for domain/application layers (engine loop, cost calc,
  key builders, template rendering).
