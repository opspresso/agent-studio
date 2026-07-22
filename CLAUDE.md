# CLAUDE.md

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
Node 22, pnpm 11 (both pinned). CI (`.github/workflows/ci.yml`) runs typecheck → test → build.

### Local development

```bash
docker run -d -p 8000:8000 amazon/dynamodb-local   # local DynamoDB
pnpm init-local-table                              # create table + GSIs (uses AWS_REGION, default ap-northeast-2)

pnpm tsx scripts/mock-llm.ts                              # mock OpenAI-compatible LLM (set LLM_BASE_URL=http://127.0.0.1:8002/v1)
pnpm tsx --env-file=.env.local scripts/dev-session.ts    # print a signed session cookie (bypasses Google OAuth)
pnpm tsx --env-file=.env.local scripts/integration-check.ts  # repos + engine against local DynamoDB (NOT in CI)
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
- `src/lib/` — auth, session, config, sse, secret-encryption, and the composition root.

**Composition root is `src/lib/container.ts`.** Route handlers and pages get repositories
and `executionDeps` from `container.ts` — do not import `infrastructure/` directly from a
route/page. Some use cases inject ports via a deps bag (`ChatDeps` in
`src/application/chat/deps.ts` is the cleanest example).

Read `docs/ARCHITECTURE.md` for the full single-table key map, domain semantics, and API surface.

### LLM engine (the core)

`src/application/llm/engine.ts` is pure logic with **everything injected** (channel,
recordUsage, callMcpTool, loadSkill, runSubagent, generateImage) — so it is tested with no
network/DB via `tests/fakeChannel.ts`. `src/application/execution/runProject.ts` is the
composition point that resolves a version's skills/MCP tools/subagents and assembles those
deps. Key behaviors:

- One OpenAI-compatible channel for all providers; model ids are `provider/model`. Routing
  by per-provider channels is configured via `LLM_PROVIDER_*` env (see README).
- `runAgent` is a recursive multi-turn tool loop: all `tool_calls` of a response aggregate
  into one assistant message; builtin `Skill` (progressive skill loading) and
  `transfer_to_agent` (subagent transfer) are intercepted before MCP dispatch; a turn guard
  stops the loop.
- Fallback: on a retryable error (429/5xx) **before the first chunk**, retry once with
  `fallbackModel`; a mid-stream failure yields an `{error}` chunk and does not retry.

### DynamoDB single-table

One table, keys `PK`/`SK` + `GSI1`/`GSI2`. **All key strings come from
`src/infrastructure/db/keys.ts` — never hand-write them elsewhere.** List queries must
paginate through the shared `queryAll()` helper (`src/infrastructure/db/query.ts`): a single
Query page caps at 1MB and unpaginated lists silently truncate. Usage rows are daily
per-project-per-model maps updated with atomic `ADD`; a run's per-turn usage is buffered by
`createUsageAggregator` and flushed once at run end (`recordUsage.ts`).

### Auth & authorization

Better Auth 1.6 + Google OAuth, custom DynamoDB adapter (`src/lib/auth-adapter.ts`). Login is
restricted to `ALLOWED_EMAIL_DOMAINS`. Route handlers wrap in `withAuth(...)`
(`src/lib/session.ts`), which 401s without a session and passes `SessionUser` as the first arg.

Authorization model: **projects are a shared catalog** — any signed-in user may read and run
any project, but mutations (update/delete/publish, version create/update, Slack config) are
owner-only via `assertProjectOwner` (→ 403). Chats are per-owner private. MCP/agent/skill
registries are shared: reads are open to any signed-in user; mutations go through
`withAdminAuth`, restricted to `ADMIN_EMAILS` when set (unset = any signed-in user).

### Other subsystems

- **Secrets**: stored headers/tokens are AES-256-GCM encrypted (`enc:v1:` prefix), masked
  (length-preserving asterisks) on read, decrypted only at dispatch (`src/lib/secret-encryption.ts`). A masked
  or empty value on update preserves the stored secret.
- **SSRF guard**: operator-registered MCP/agent URLs are validated by
  `src/infrastructure/net/ssrfGuard.ts` (reject non-http(s) and private/loopback/link-local/
  metadata addresses) at both registration and dispatch.
- **Slack**: signature verified (HMAC + `timingSafeEqualString`, 5-min replay window);
  events are deduplicated exactly-once via `slackEventRepository.claim` (conditional put).
  Per-project bots and one workspace-default bot coexist.
- **A2A**: inbound endpoints gated by `A2A_API_KEY` (constant-time compare); task store is
  in-memory (single-instance assumption, TTL/LRU evicted). Outbound A2A/agent registry.
- **Errors**: shared `AppError` base carrying an HTTP status (`src/application/errors.ts`);
  `apiError` (`src/app/api/projects/_lib/http.ts`) maps any of them, else a generic 500.
- **SSE**: `src/lib/sse.ts` — `sseResponse` (OpenAI `[DONE]` terminator) vs `sseResponseRaw`
  (A2A JSON-RPC framing).

## Conventions that bite

- Domain purity: nothing in `src/domain/` imports infrastructure/framework/AWS.
- Chat tool-message persistence is deliberately UI-only: tool rows are persisted for display
  but **not replayed** into engine context (the stored assistant message carries no
  `tool_calls`, so `toEngineMessages` drops the orphans). See `src/application/chat/AGENTS.md`
  before changing `run.ts`/`messageMapping.ts`.
- Tests mock at boundaries: `fetch` via `vi.stubGlobal`, the DynamoDB doc client via
  `vi.mock("@/infrastructure/db/client")`. Keep tests deterministic — no real `Date.now`,
  timers, randomness, or network (repository integration is only in the manual
  `integration-check.ts`, not CI).
