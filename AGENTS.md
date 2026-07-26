# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Agent Studio is a single Next.js 16 full-stack app: an internal LLM platform for
prompt / agent / cost management (projects & versions, an LLM engine, agents
(subagents + external registry), skills, MCP tools, chats, cost dashboard).

## Commands

```bash
pnpm dev            # next dev (http://localhost:3000)
pnpm build          # production build (Next standalone) — validates route handlers + instrumentation
pnpm typecheck      # tsc --noEmit, strict + noUncheckedIndexedAccess
pnpm test           # vitest run (unit tests in tests/)
pnpm test:watch     # vitest watch

# run a single test file / by name
pnpm exec vitest run tests/engine.test.ts
pnpm exec vitest run -t "streamWithFallback"
```

There is **no lint step** (no ESLint config); `typecheck` + `test` are the checks.
Node 22 (`engines >=22`), pnpm 11 (pinned via `packageManager`). CI (`.github/workflows/ci.yml`) runs typecheck → test → integration test → build.

### Local development

```bash
docker run -d -p 8000:8000 amazon/dynamodb-local   # local DynamoDB
pnpm init-local-table                              # create table + GSIs (uses AWS_REGION, default ap-northeast-2)

pnpm tsx scripts/mock-llm.ts                              # mock OpenAI-compatible LLM (set LLM_BASE_URL=http://127.0.0.1:8002/v1)
pnpm tsx --env-file=.env.local scripts/dev-session.ts    # print a signed session cookie (bypasses Google OAuth)
pnpm tsx --env-file=.env.local scripts/integration-check.ts  # repos + engine against local DynamoDB (CI runs this as pnpm test:integration)
pnpm tsx --env-file=.env.local scripts/seed-skills.ts    # seed sample skills
```

Required env for any real run (validated fail-fast at boot by `src/instrumentation.ts`):
`LLM_BASE_URL`, `LLM_API_KEY`, `AES_ENCRYPTION_KEY` (32-byte base64). Google OAuth creds
are only needed for real login. See `.env.example`; `STAGE` = local | alpha | prod.

## Architecture

Clean Architecture with a strict dependency rule — **`app → application → domain ← infrastructure`**:

- `src/domain/` — entities + repository ports. Pure TS, **no framework/AWS/React imports** (enforced by convention; keep it that way).
- `src/application/` — use cases. Depend on domain ports only. Orchestration lives here.
- `src/infrastructure/` — adapters: DynamoDB repositories, LLM channel, MCP client, Slack, A2A, GitHub, net/crypto helpers.
- `src/app/` — Next.js App Router pages + API route handlers (presentation).
- `src/lib/` — cross-cutting glue: the composition root, auth, session, config,
  runtime-settings. Application and infrastructure may import it; domain never does.
- `src/shared/` — dependency-free helpers (dates, slugs, timeouts, list parsing,
  constant-time compare). The bottom of the graph: it imports nothing from `@/`.

**Composition is distributed across a few deliberate wiring sites.** `src/lib/container.ts`
wires the repositories, the domain ports (`SecretCipher`, `UrlPolicy`,
`RemoteAgentDispatcher`, `McpToolProbe`, `McpSessionFactory`), the four registry-slice
singletons and `executionDeps`; chats wire `ChatDeps` in `src/app/api/chats/_deps.ts`;
Slack wires `SlackEventDeps` in `src/app/api/slack/events/_lib/`. Route handlers get
repositories and `executionDeps` from these wiring sites — do not import `infrastructure/`
directly from a route/page, and application code must not import `container.ts` (deps are
injected, never pulled).

`tests/architecture.test.ts` enforces all of the above mechanically: seven layer rules with
empty allowlists, plus named single-owner invariants that fail when a second copy of a
decision appears. Adding a violation is not quietly possible — fix the import, don't widen
the rule.

Read `docs/ARCHITECTURE.md` for the full single-table key map, domain semantics, and API surface.

### LLM engine (the core)

`src/application/llm/engine.ts` is pure logic with **everything injected** (channel,
recordUsage, callMcpTool, loadSkillContent, runSubagent, generateImage) — so it is tested with no
network/DB via `tests/fakeChannel.ts`. `generateImage` (the builtin GenerateImage tool) is
injected per version — only when `parameters.imageGeneration: true`, model from
`parameters.imageModel` else the registry default. `src/application/execution/runProject.ts` is the
composition point that resolves a version's skills/MCP tools/subagents and assembles those
deps. Key behaviors:

- One OpenAI-compatible channel for all providers; model ids are `provider/model`. Routing
  by per-provider channels is configured via `LLM_PROVIDER_*` env (see README).
- `runAgent` is a recursive multi-turn tool loop: all `tool_calls` of a response aggregate
  into one assistant message; a builtin (`Skill`, `transfer_to_agent`, `GenerateImage`,
  `EditImage`) serves a call only when that builtin was **offered** this run, and every other
  name goes to MCP — the MCP calls of one response run concurrently while builtins run in call
  order, and results stay in call order; a turn guard stops the loop.
- Fallback: on a retryable error (429/5xx) **before the first chunk**, retry once with
  `fallbackModel`; a mid-stream failure yields an `{error}` chunk and does not retry.
- Stream author contract: top-level chunks are unauthored; only subagent chunks carry
  `author`. Filter with `isTopLevelChunk()` (`src/domain/llm/types.ts`) — never re-derive.
  See `src/application/llm/AGENTS.md` for the full loop invariants before editing
  `engine.ts`/`pii.ts`.

### DynamoDB single-table

One table, keys `PK`/`SK` + `GSI1`/`GSI2`. **All key strings come from
`src/infrastructure/db/keys.ts` — never hand-write them elsewhere.** List queries must
paginate through the shared `queryAll()` helper (`src/infrastructure/db/query.ts`): a single
Query page caps at 1MB and unpaginated lists silently truncate. Usage rows are daily
per-project-per-model maps updated with atomic `ADD`; a run's per-turn usage is buffered by
`createUsageAggregator` and flushed once at run end (`recordUsage.ts`).

### Auth & authorization

Better Auth 1.6 + Google OAuth, custom DynamoDB adapter (`src/infrastructure/db/authAdapter.ts`). Login is
restricted to `ALLOWED_EMAIL_DOMAINS`. Route handlers wrap in `withAuth(...)`
(`src/lib/session.ts`), which 401s without a session and passes `SessionUser` as the first arg.

Authorization model: **projects are a shared catalog** — any signed-in user may read and run
any project, but mutations (update/delete/publish, version create/update, Slack config) are
owner-only via `assertProjectOwner` (→ 403). Chats are per-owner private. MCP/agent/skill
registries are shared: reads are open to any signed-in user; mutations go through
`withAdminAuth`, restricted to `ADMIN_EMAILS` when set (unset = any signed-in user).

### Other subsystems

- **Runtime settings**: the admin-only `/settings` page stores env-var overrides
  (admin/allowed-domain lists, default LLM channel, per-provider LLM channels, skills repo,
  A2A key, public base URL) in the `SETTINGS#app` item. Read via
  `src/lib/runtime-settings.ts` — DB override → env fallback, cached in memory
  (`SETTINGS_CACHE_TTL_MS`, default 5s, invalidated on write — the invalidation is
  process-local, so the TTL bounds cross-instance staleness). Never read those env vars directly at
  dispatch; go through runtime-settings.
- **Secrets**: stored headers/tokens are AES-256-GCM encrypted (`enc:v1:` prefix), masked
  on read (length-preserving; values ≥20 chars reveal their first/last 2 chars, which
  decrypts at read in the admin/owner-gated views) and decrypted for outbound dispatch
  (`src/infrastructure/crypto/secretEncryption.ts`). A masked or empty value on update
  preserves the stored secret; a masked value under a key with no stored counterpart is
  dropped. Two app-issued secrets can be read back in plaintext through a dedicated
  `POST …/reveal` (never a GET — the body is a live credential): the app-wide A2A key
  (admin-only) and a project's API token (owner-only). The project token is therefore
  stored encrypted rather than hashed; tokens predating that still verify by hash but
  cannot be revealed. Every reveal is logged with the caller's email.
- **PII filtering**: opt-in per version (`parameters.piiFiltering`) — emails/phone numbers
  are regex-masked with reversible format-preserving tokens before every LLM dispatch and
  restored in responses, including streaming and subagent transfers
  (`src/application/llm/pii.ts`). Best-effort (regex; emails + phones only).
- **SSRF guard**: operator-registered MCP/agent URLs are validated by
  `src/infrastructure/net/ssrfGuard.ts` (reject non-http(s) and private/loopback/link-local/
  metadata addresses) at both registration and dispatch.
- **Slack**: signature verified (HMAC + `timingSafeEqualString`, 5-min replay window);
  events are deduplicated exactly-once via `slackEventRepository.claim` (conditional put),
  whose claim is a lease settled by `settle` — an instance that dies mid-processing leaves a
  reclaimable claim rather than an event recorded as handled by nobody.
  Per-project bots and one workspace-default bot coexist.
- **A2A**: inbound endpoints gated by `A2A_API_KEY` (constant-time compare); task state is
  persisted per-project in the single table (`createA2aTaskStore`), TTL-expired, with a
  terminal-state-guarding conditional write so a concurrent complete/cancel never regresses a
  finished task. Outbound A2A/agent registry.
- **Errors**: shared `AppError` base carrying an HTTP status (`src/application/errors.ts`);
  `apiError` (`src/app/api/_lib/http.ts`) maps any of them, else a generic 500.
- **SSE**: `src/app/api/_lib/sse.ts` — `sseResponse` (OpenAI `[DONE]` terminator) vs `sseResponseRaw`
  (A2A JSON-RPC framing).

## Conventions that bite

- Domain purity: nothing in `src/domain/` imports infrastructure/framework/AWS.
- Chat persistence is flattened but tool traffic **is** replayed: the stored assistant
  message carries the run's top-level `tool_calls`, and `toEngineMessages` pairs each tool
  row with its call and re-emits it *after* that message (storage order within a turn is the
  reverse of the wire order). Pairing is scoped to the run a user message delimits, because
  a tool-call id is only unique within the run that made it. Bounded three ways — the last N
  turns, a tool-text budget, and a history budget over whole runs — and every drop is
  reported as a `warning` chunk rather than made silently. A call with no stored result is
  dropped rather than orphaned. See `src/application/chat/AGENTS.md` before changing
  `run.ts`/`messageMapping.ts`.
- User-image limits and encoding have single owners: caps in
  `src/domain/llm/imageLimits.ts` (client composers, API bodies, Slack all read them) and the
  `data:` encoding in `imageDataUrl`/`parseImageDataUrl` (`src/domain/llm/types.ts`). Copies of
  either had already drifted apart once — never restate a cap locally.
- Tests mock at boundaries: `fetch` via `vi.stubGlobal`, the DynamoDB doc client via
  `vi.mock("@/infrastructure/db/client")`. Keep tests deterministic — no real `Date.now`,
  timers, randomness, or network (repository integration lives in
  `integration-check.ts`, run against a local DynamoDB — in CI as its own step,
  outside vitest).
