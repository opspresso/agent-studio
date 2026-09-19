# AGENTS.md

Working rules for coding agents in this repository (`CLAUDE.md` is a symlink to this file).

Agent Studio is a single Next.js 16 full-stack application installed inside one enterprise
network. One install is one company; there is no multi-tenancy. Boot, sign-in, project runs,
and the console must work with the public internet unreachable.

This file is a routing contract: what to read, what not to break, and where each decision is
owned. System explanations belong in `docs/`; historical failure narratives belong in git.

## Development status and compatibility

This project is under active development. Backward compatibility is not required unless the
user explicitly requests it. Prefer the clean current-state design over compatibility shims;
breaking changes to APIs, configuration, schemas, and stored data formats are allowed. Any
operation that destroys existing data or git history still requires explicit user approval and
the applicable safety checks.

## Start here

Read only the documents relevant to the change, but read every required local instruction
before editing its subsystem.

| Change area | Authority |
|---|---|
| End-to-end run shape, product boundary | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Visual system maps | [docs/DIAGRAMS.md](docs/DIAGRAMS.md) |
| Subsystem decisions | [docs/design/](docs/design/) |
| Single-owner decisions | [docs/OWNERSHIP.md](docs/OWNERSHIP.md) |
| API contracts | [docs/API.md](docs/API.md) |
| Environment and fixed limits | [docs/CONFIGURATION.md](docs/CONFIGURATION.md) |
| Deploy, probes, retention | [docs/OPERATIONS.md](docs/OPERATIONS.md) |
| Auth, secrets, SSRF, PII | [docs/SECURITY.md](docs/SECURITY.md) |
| Setup, scripts, CI | [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) |
| Unbuilt work only | [docs/MILESTONES.md](docs/MILESTONES.md) |
| Agent runtime | `src/application/runtime/AGENTS.md`, then [design/execution.md](docs/design/execution.md) |
| Document parsing, generation, editing and workers | [design/documents.md](docs/design/documents.md) |
| Chat persistence and replay | `src/application/chat/AGENTS.md`, then [design/chat.md](docs/design/chat.md) |
| Persistent Workspace, Sandbox and coding jobs | [design/workspaces.md](docs/design/workspaces.md) |

## Commands

```bash
pnpm dev            # next dev on :3000
pnpm typecheck      # strict tsc --noEmit
pnpm test           # vitest unit tests
pnpm build          # production build; validates route signatures and instrumentation

pnpm exec vitest run tests/engine.test.ts
pnpm exec vitest run -t "streamWithFallback"
```

There is no lint step. CI's `verify` job runs typecheck → test → integration test; the
image-release job builds through Dockerfile. Run build locally when required below. Node 24
and pnpm 11 are required (`packageManager` is pinned). See `docs/DEVELOPMENT.md` for CI scope.

```bash
docker compose up -d postgres minio minio-init
pnpm db:migrate
pnpm test:integration

pnpm tsx scripts/mock-llm.ts
pnpm tsx --env-file=.env.local scripts/dev-session.ts
pnpm tsx --env-file=.env.local scripts/seed-skills.ts
```

The local Compose project is pinned to `agent-studio-local` and owns its PostgreSQL and MinIO
volumes. Never run `docker compose down -v` without explicit approval. Integration checks may
use only a database whose name ends in `_test`.

Any real run requires `DATABASE_URL`, `LLM_BASE_URL`, `LLM_API_KEY`, and a 32-byte base64
`AES_ENCRYPTION_KEY`. Alpha/prod also requires `ADMIN_EMAILS` plus a sign-in method. Production
refuses to boot without an explicit `STAGE`. See [CONFIGURATION.md](docs/CONFIGURATION.md).

## Architecture contract

Use Clean Architecture with high cohesion and low coupling. Follow the
[module boundaries and reuse rules](docs/ARCHITECTURE.md#모듈-경계와-재사용) when choosing
responsibilities and abstractions.

### Dependency direction

**`app → application → domain ← infrastructure`**

- `src/domain/` owns entities, value rules, and repository ports. It is pure TypeScript and
  imports no framework, AWS, infrastructure, or `shared` module.
- `src/application/` owns use cases and orchestration. It imports domain, dependency-free shared
  helpers, and the standard library only. `@a2a-js/sdk` and `@openai/agents` are the explicit
  protocol/runtime exceptions; their native contracts are not redefined as domain ports. The pure `runMetrics` leaf is
  the only current `lib` import. It never imports `container.ts`; dependencies are injected.
- `src/infrastructure/` owns adapters: PostgreSQL/item store, vectors, object store, LLM, MCP,
  messaging, A2A, GitHub, network, and crypto.
- `src/app/` owns App Router presentation. It does not import infrastructure directly; routes
  receive bound use cases or dependencies from a wiring site.
- A `"use client"` file may not import application or infrastructure values. Type-only imports
  are allowed because they are erased. Shared runtime helpers go to `src/shared/`; domain
  vocabulary and rules stay in domain even when a client uses them.
- `src/lib/` is cross-cutting server glue: composition root, auth, session, config, and runtime
  settings. Infrastructure may import it; application may import only named pure leaves.
- `src/shared/` is the dependency-free bottom of the graph and imports nothing from `@/`.

`tests/architecture.test.ts` enforces these boundaries with empty allowlists. Fix the import;
never widen an allowlist to make a failure disappear.

### Composition

Composition is limited to these wiring sites:

1. `src/lib/container.ts`
2. `src/app/api/chats/_deps.ts`
3. `src/app/api/slack/events/_lib/`
4. `src/app/api/telegram/webhook/_lib/`
5. `src/app/api/teams/messages/_lib/`
6. `src/app/api/a2a/[name]/route.ts`
7. `src/instrumentation.ts`

Only `auth.ts`, `runtime-settings.ts`, and `memberAccess.ts` are additional `lib` adapter-facing
wiring modules. A use-case slice exports `createXUseCases`; the composition root binds it once,
and routes import the bound object. Application modules that already hold a repository call the
exported free function. Routes do not choose repositories, ciphers, or registry validation.

### Single ownership

Dependency direction does not prevent duplicate decisions. Before adding a constant, wire shape,
key, cap, formatter, error identity, or collapse rule, search
[docs/OWNERSHIP.md](docs/OWNERSHIP.md) and `tests/architecture.test.ts`.

- A cap imposed by a provider or stored item belongs in domain.
- A platform policy cap belongs beside the mechanism that spends it.
- A decision is defined once; consumers import it rather than restating it.
- Bounded caller/site lists in architecture tests are contracts. Add a new site deliberately and
  update the named set in the same change.

## Required invariants

### Offline and infrastructure

- Required paths never depend on the public internet. Optional outbound integrations use a port,
  a configuration-gated adapter, and a documented offline fallback. No fixed-host fetches,
  phone-home SDKs, or CDN runtime assets. Document new options in `docs/INSTALL.md`.
- Row keys come from `src/infrastructure/db/keys.ts`. The sole cross-layer cursor exception is
  `artifactCursor` in `src/domain/artifact/repository.ts`.
- Repositories use `src/infrastructure/db/store.ts`, never raw SQL against `items`. Plain SQL is
  limited to Better Auth tables, `catalog_vectors`, encrypted `runtime_sessions`, and
  `skillRepository.describe` projection. SDK Session/checkpoint payloads use their own table because
  native state can contain inline images larger than an item row; history and approval state commit
  together with an owner-scoped revision check.
- Unbounded lists take `limit`; post-read expiry filtering passes `notExpiredAt` so filtering
  occurs before the limit counts.
- Expiring rows carry `expiresAt`; `sweepExpiredRows` performs retention on the schedule tick and
  reads still filter expired values. Without authenticated schedule ticks, the DB retention sweep
  does not run. Object lifecycle, audio-file deletion and Sandbox cleanup have separate owners.

### Execution and streams

- Every new execution entry uses the facade and opens the run bracket. Use `streamProjectRun` for
  chunk consumers, including image; `executeProjectStream`/`executeProject` for completion
  consumers. All Project executions use the same Agent loop, including image tools. See `AGENT_RUN_ENTRY_POINTS` in the architecture test.
- Workspace jobs use `executeWorkspaceTask` and the shared `openTaskRun` bracket. Ordinary commands
  have no Studio model configuration; native CLI history stays in the Workspace checkpoint. Workspace polling
  must distinguish a missing operation from a transport failure and never replay uncertain work.
- A surface needing only chunks stays behind `streamProjectRun`. Image generation and editing
  run through `application/execution/imageTool.ts` inside the same Agent bracket.
- `resolveRunTools` receives `discoveryQueries`; omitting them silently disables dynamic discovery.
  Keep `TOOL_RESOLUTION_SITES` accurate.
- The facade forwards `caller` through `toRunInput`; `callerFor` is the only prompt gate.
  `RunOrigin` carries caller through transfers, and each child applies its own `callerContext`.
- `reasoningTrace` gates only emission of `delta.reasoningContent`. Provider-facing reasoning
  accumulation always remains attached to its turn. Surfaces fold top-level reasoning with
  `isTopLevelChunk`, preserve token counts, and use `createTextPacer` for component state. Keep
  `REASONING_FOLD_SITES` complete.
- `createSseResponse` waits briefly for the first chunk to preserve pre-stream HTTP status, then
  uses `FIRST_CHUNK_GRACE_MS`. Any change that removes an output axis must recheck silent-first-
  chunk behavior.
- Top-level chunks are unauthored; only subagent chunks carry `author`. Never rederive the check;
  use `isTopLevelChunk()`.
- Loss becomes a warning: unusable bindings, truncated transcript/tool result, or dropped history.
  Gains such as discovered capabilities are not warnings. `collectedWarning` owns run loss.

### Chat and console

- Before editing chat persistence or approval use cases, read `src/application/chat/AGENTS.md`.
  Native SDK Session owns model/tool history. Display storage order is reverse wire order;
  call/result IDs remain scoped to one run. Session, display reads and reconnect logs have separate bounds.
- A chat run outlives its initiating connection. Routes do not pass an `AbortController` to SSE;
  the detach wrapper remains outermost; clients do not abort the fetch on unmount.
- `use-stick-to-bottom` alone owns chat viewport scrolling. Thread descendants cannot scroll on
  both axes. Store notifications remain collection-windowed and messages reference-stable.
- Enter submission goes through `isSubmitEnter` to preserve IME composition, including keyCode
  229 behavior.
- Sidebar and thread reads remain bounded. `sinceSeq=0` is a real bound, and the tail marker is
  cleared when `chatId` changes.
- Run-log ordering is **persist → terminal entry → release lease**. Lease release stays in
  `runLog.ts`.
- Console translations use `en.ts` as the key source and typed `ko.ts`. Client components use
  `useT`, server components use `getT`; locale is a cookie, not a route segment. Error messages
  and API product nouns remain English.
- Format reader-facing timestamps through `src/shared/date.ts` with an explicit `useLocale()`
  locale. Bare `toLocaleString()` can cause hydration drift.

### Models, media, and artifacts

- Published model facts come from `opspresso/agent-models`, not this repository. This repo owns
  loader shape and `SUPPORTED_PROVIDERS`; `pnpm sync-models` refreshes the committed offline
  snapshot. Self-hosted declarations are a deployment-owned overlay via `loadSelfHostedModels`.
- Image caps and data-URL rules live in `src/domain/llm/imageLimits.ts`; document caps live in
  `documentLimits.ts`. Never copy either locally.
- Run output bytes are captured at `openRun`, never at an individual producer. Keep
  `ARTIFACT_CAPTURE_SITES` complete.
- `EngineChunk.file` and `.image` are distinct output axes but consumers inspect both. File bytes
  never enter model context and are removed after storage; `producedFiles.ts` owns addressing and
  loss text. Raw chunk routes use `withAddressedFiles` and remain bounded by
  `RAW_CHUNK_STREAM_ROUTES`.
- Non-image attachments become framed text at the receiving surface through
  `documentParts.ts`/`DocumentExtractor`. `decodeUtf8Text` decides whether bytes are UTF-8;
  `Buffer.toString("utf-8")` plus `try/catch` is not validation.

### Integrations, contracts, and secrets

- Routes use `withAuth`, `withMemberAuth`, or `withAdminAuth` as documented; `isAdminEmail` and
  `isConfiguredAdmin` are not interchangeable. Dispatch reads operator overrides through
  `src/lib/runtime-settings.ts`, never directly from environment variables.
- Operator URLs are checked at registration and dispatch through `fetchPublicUrl`. Logging goes
  through `src/shared/logger.ts` except the documented domain warning and browser error boundaries.
- A masked or empty secret update preserves stored data; a mask with no stored counterpart is
  dropped. A mask never creates a secret.
- Treat every `@modelcontextprotocol/client` bump as a protocol change. Verify protocol revision,
  `mode: "auto"` fallback, `listMaxPages` throw behavior, and `SdkErrorCode` mapping.
- Plugin sync never owns deletion. Deletions pass through the use case with `actorEmail`; skills
  write through their repository, servers through `mcpUseCases` for SSRF validation; `mcp.json`
  headers are never imported; `repoOwned.ts` owns the route-layer 403.
- Response types live where responses are built. Client modules import producer types type-only;
  route-built shapes use a named `…Response` and `satisfies`. Spreads do not prove their extra
  fields, so exported use-case views must already be safe/masked boundaries.

### Tests and documentation

- Unit tests mock at boundaries: global `fetch`, item store through `tests/fakeStore.ts`, and the
  connection pool. They use no real network, clock, timer, or randomness. Repository integration
  stays in `scripts/integration-check.ts` against the dedicated PostgreSQL test database.
- New behavior and bug fixes include focused regression coverage. Run typecheck and tests; run
  build when route signatures, instrumentation, or production bundling can be affected.
- Docs describe current state only. Delete completed milestones; git history and releases record
  the past.

## Change checklist

Before finishing:

- Read the authority and any nested `AGENTS.md` for the changed subsystem.
- For fixes, follow [root-cause improvement](docs/DEVELOPMENT.md#근본-원인-중심의-개선) and
  verify that the owning layer and other affected paths are addressed.
- Confirm every import follows the dependency direction and every new decision has one owner.
- Confirm required paths still work offline and no secret or unbounded read was introduced.
- Run the checks appropriate to the risk, then inspect the complete diff.
- If `tests/architecture.test.ts` fails, fix the architecture; do not relax the contract.
