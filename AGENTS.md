# AGENTS.md

Working rules for coding agents in this repository (`CLAUDE.md` is a symlink to this file).

Agent Studio is a single Next.js 16 full-stack app: an internal LLM platform for
prompt / agent / cost management (projects & versions, an LLM engine, agents
(subagents + external registry), skills, MCP tools, chats, cost dashboard).

**This file is the working contract — what to run, what not to break, and who owns which
decision.** It is not a description of the system; that is
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). When something here is a summary, the linked
document is authoritative and this file must not restate it.

| Need | Read |
|---|---|
| Why the system is shaped this way | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| An endpoint's contract | [docs/API.md](docs/API.md) |
| An env var or a fixed limit | [docs/CONFIGURATION.md](docs/CONFIGURATION.md) |
| Deploy / probe / scale / retention | [docs/OPERATIONS.md](docs/OPERATIONS.md) |
| Auth, secrets, SSRF, PII | [docs/SECURITY.md](docs/SECURITY.md) |
| Local setup, scripts, CI | [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) |
| What is still unbuilt | [docs/MILESTONES.md](docs/MILESTONES.md) |
| The engine's loop invariants | `src/application/llm/AGENTS.md` |
| Chat persistence and replay | `src/application/chat/AGENTS.md` |

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

There is **no lint step** (no ESLint config); `typecheck` + `test` are the checks, and
`build` is the third — it is what catches an invalid route handler signature. Node 24
(`engines >=24`), pnpm 11 (pinned via `packageManager`). CI runs typecheck → test →
integration test → build.

```bash
docker compose up -d dynamodb              # dev DynamoDB on :8083
pnpm init-local-table                      # create table + GSIs (uses AWS_REGION, default ap-northeast-2)

pnpm tsx scripts/mock-llm.ts                             # mock OpenAI-compatible LLM (LLM_BASE_URL=http://127.0.0.1:8002/v1)
pnpm tsx --env-file=.env.local scripts/dev-session.ts    # print a signed session cookie (bypasses Google OAuth)
pnpm tsx --env-file=.env.local scripts/seed-skills.ts    # seed sample skills

# Integration check — a *separate* instance on :8084 and the `agent-studio-test`
# table, because it cascade-deletes what it writes. Never point it at :8083 (the
# script refuses).
docker compose up -d dynamodb-test
pnpm init-local-table:test
pnpm test:integration                      # CI runs this same pair
```

> **Both DynamoDB Local containers are shared with every other project on this machine.**
> `compose.yaml` pins the compose project name to `localdev`, so `docker compose up -d
> dynamodb` from another repository reuses these. Table names, not ports, separate the
> projects: never widen a cleanup past `DYNAMODB_TABLE_NAME`, and **never run
> `docker compose down -v`** (or `--remove-orphans`).

Required env for any real run (validated fail-fast at boot by `src/instrumentation.ts`):
`LLM_BASE_URL`, `LLM_API_KEY`, `AES_ENCRYPTION_KEY` (32-byte base64). `STAGE=alpha|prod`
additionally requires `ADMIN_EMAILS` and `ALLOWED_EMAIL_DOMAINS`.

## The dependency rule

**`app → application → domain ← infrastructure`**

- `src/domain/` — entities + repository ports. Pure TS, **no framework/AWS/React imports**,
  not even `shared`.
- `src/application/` — use cases. Depend on domain ports only. Orchestration lives here, and
  it **must not import `container.ts`** — deps are injected, never pulled.
- `src/infrastructure/` — adapters: DynamoDB repositories, LLM channel, MCP client, Slack,
  A2A, GitHub, net/crypto helpers.
- `src/app/` — App Router pages + API route handlers. **Do not import `infrastructure/`
  directly**; get repositories and `executionDeps` from a wiring site.
- `src/lib/` — cross-cutting glue: composition root, auth, session, config, runtime-settings.
  Infrastructure may import it; application may reach only its pure leaves (today
  `runMetrics`); domain never touches it.
- `src/shared/` — dependency-free helpers. The bottom of the graph: it imports nothing from
  `@/`.

Composition happens at exactly four wiring sites: `src/lib/container.ts` (repositories, the
domain ports, the registry-slice singletons, `executionDeps`/`imageDeps`),
`src/app/api/chats/_deps.ts` (`ChatDeps`), `src/app/api/slack/events/_lib/`
(`SlackEventDeps`), and `src/app/api/a2a/[name]/route.ts` (per-request A2A SDK
handler assembly over `executionDeps`).

`tests/architecture.test.ts` enforces all of this with **empty allowlists**. When it fails,
**fix the import — do not widen the rule.**

## Single-owner invariants

The layer rules say which direction an import may point. They say nothing about the same
decision being written twice, which is the failure this codebase kept hitting: `McpTool`
reached four definitions that had already drifted apart, the DynamoDB conditional-write error
name was spelled at seven call sites — only one of which handled the transactional form — and
the image-usage collapse was derived independently four times.

Each decision below has one owning file. `tests/architecture.test.ts` fails on a second copy
**and** on the owner losing the definition. Before writing any of these, check whether you are
about to make copy number two.

| Decision | Owner |
|---|---|
| The shape of an MCP tool | `src/domain/mcp/types.ts` |
| Which hosts may skip the outbound URL guard | `src/domain/mcp/types.ts` |
| Which storage errors mean a lost conditional write | `src/application/errors.ts` |
| How an audit row is written | `src/application/audit/recordAudit.ts` |
| Collapsing an image model's three token counts into a usage row | `src/domain/llm/models.ts` |
| Constant-time secret comparison | `src/shared/timingSafe.ts` |
| Parsing a comma-separated config list | `src/shared/parseList.ts` |
| Parsing a markdown frontmatter block | `src/shared/frontmatter.ts` |
| The subagent nesting limit | `src/application/execution/subagentRunner.ts` |
| The per-run MCP tool cap | `src/application/execution/mcpTools.ts` |
| How many agents one dispatch may run | `src/application/llm/engine.ts` |
| How an agent run's prompt and tool set are assembled | `assembleAgentRun` in `src/application/llm/engine.ts` |
| Deriving a run's context budget from the model's window | `src/application/llm/contextBudget.ts` |
| Whether a run's trace is sampled | `src/application/execution/traceLifecycle.ts` |
| Evaluating when a schedule fires | `src/domain/trigger/cron.ts` |
| The managed-workload name rule | `MANAGED_NAME` in `src/shared/slug.ts` |
| Merging concurrent generators | `src/shared/mergeGenerators.ts` |
| Deriving the transfer chain a chunk came from | `src/app/_lib/authorPaths.ts` |
| Deriving why a run ended from its chunks | `chunkTermination`/`runTermination` in `src/domain/llm/types.ts` |
| The 401 response body | `src/shared/unauthorized.ts` |
| The code a refused sign-in is identified by | `src/shared/signInError.ts` |
| Writing to the console | `src/shared/logger.ts` |
| What wraps a top-level run | `src/application/execution/runBracket.ts` |
| Which project type runs which way | `src/application/execution/deps.ts` |
| How the execution facade dispatches an agent project | `src/application/execution/deps.ts` |
| How a Slack reply is delivered | `src/application/slack/replyStream.ts` |
| The Slack Web API surface a run uses | `SlackClientPort` in `src/application/slack/types.ts` |
| Deciding whether bytes are UTF-8 text | `src/shared/utf8Text.ts` |
| User-document caps | `src/domain/llm/documentLimits.ts` |
| How an attached document is framed in a turn | `src/application/llm/documentParts.ts` |
| The name every entry is addressed by | `isSlug` in `src/shared/slug.ts` |

Other decisions with a single owner that the test cannot express as a pattern, but that the
same rule applies to:

| Decision | Owner |
|---|---|
| Every DynamoDB key string | `src/infrastructure/db/keys.ts` |
| Paginated list reads | `queryAll()` in `src/infrastructure/db/query.ts` |
| Which pages are public | `src/proxy.ts` |
| Whether a chunk is top-level | `isTopLevelChunk()` in `src/domain/llm/types.ts` |
| Which version a run executes | `resolveRunnableVersion` in `src/application/project/` |
| User-image caps | `src/domain/llm/imageLimits.ts` |
| `data:` image encoding | `imageDataUrl`/`parseImageDataUrl` in `src/domain/llm/types.ts` |
| Turning a stored image reference into an address | `resolveImageUrl` in `src/domain/chat/imageRefs.ts` |
| How long a signed image URL lives, per reader | `src/application/chat/imageUrls.ts` |
| Row TTLs | `src/infrastructure/db/ttl.ts` |
| The UTC day a usage row is keyed by | `utcDay` in `src/shared/date.ts` |
| What a repo sync did, and what it left to a person | `src/domain/sync/types.ts` |
| The brand palette and component defaults | `src/app/theme.ts` |

## Subsystem map

One line each — the linked section is the authority.

- **LLM engine** (`src/application/llm/engine.ts`) — pure logic with **everything injected**
  (channel, `recordUsage`, `callMcpTool`, `loadSkillContent`, `runSubagent`, `generateImage`,
  `editImage`), so it tests with no network or DB via `tests/fakeChannel.ts`.
  `src/application/execution/runProject.ts` is the composition point that resolves a version's
  skills/MCP tools/subagents and assembles those deps.
  → `src/application/llm/AGENTS.md`, then
  [ARCHITECTURE.md](docs/ARCHITECTURE.md#llm-engine)
- **Run bracket** — the single owner of what wraps a top-level run: the in-flight metric, the
  daily cost guard, the per-caller concurrency guard, the correlation id. Exactly four
  functions admit a run. →
  [ARCHITECTURE.md](docs/ARCHITECTURE.md#the-run-bracket)
- **Images** — three drawing paths (an `image` project, an agent run's builtins, an image
  subagent) over one `ImageChannel` port; source bytes decide edit vs generate, and
  `toImageUsageRecord` is the one collapse into a usage row. →
  [ARCHITECTURE.md](docs/ARCHITECTURE.md#images)
- **Single-table DynamoDB** — one table, `PK`/`SK` + `GSI1`/`GSI2`; usage rows are daily
  per-project-per-model maps updated with atomic `ADD`. →
  [ARCHITECTURE.md](docs/ARCHITECTURE.md#dynamodb-single-table-design)
- **Auth & authorization** — `withAuth`/`withAdminAuth` for routes, `src/proxy.ts` for pages;
  projects are a shared catalog with owner/admin-gated mutations. **`isAdminEmail` and
  `isConfiguredAdmin` are not interchangeable.** →
  [SECURITY.md](docs/SECURITY.md#authorization-model)
- **Secrets** — AES-256-GCM at rest (`enc:v1:`), masked on read, three revealable via POST.
  → [SECURITY.md](docs/SECURITY.md#secrets-at-rest)
- **Runtime settings** — DB override → env fallback, cached process-locally. Never read those
  env vars directly at dispatch; go through `src/lib/runtime-settings.ts`. →
  [CONFIGURATION.md](docs/CONFIGURATION.md#resolution-order)
- **MCP** — one session owner, discovery cached per `url + headers`, managed servers on
  loopback by provenance, per-project OAuth connections. →
  [ARCHITECTURE.md](docs/ARCHITECTURE.md#mcp)
- **PII filtering** — opt-in per version; bounds what the LLM and engine context see, **not**
  what an MCP server receives. → [SECURITY.md](docs/SECURITY.md#pii-filtering-and-where-it-stops)
- **SSRF guard** — operator URLs checked at registration *and* dispatch, through
  `fetchPublicUrl`. → [SECURITY.md](docs/SECURITY.md#outbound-requests-ssrf)
- **Slack / A2A / triggers** — per-project bots, both A2A directions, published-only webhook
  and schedule runs deduplicated by conditional claims; a CronJob ticks the schedule scan. →
  [ARCHITECTURE.md](docs/ARCHITECTURE.md#slack)
- **Attribution** — `RunActor { kind, id }` names who caused a run; `RunOrigin` carries it
  plus the transfer chain down every subagent hop. →
  [ARCHITECTURE.md](docs/ARCHITECTURE.md#usage-and-cost-attribution)
- **Errors** — `AppError` subclasses before a stream starts, `{error}` chunks after the first
  one. `apiError` (`src/app/api/_lib/http.ts`) maps any of them. →
  [ARCHITECTURE.md](docs/ARCHITECTURE.md#error-handling)
- **Logging** — `src/shared/logger.ts` is the only place that writes to the console; lines
  carry the run's correlation id, deliberately *not* the trace id (which is sampled). →
  [OPERATIONS.md](docs/OPERATIONS.md#logging)

## Conventions that bite

- **Domain purity.** Nothing in `src/domain/` imports infrastructure, framework or AWS.
- **Never hand-write a DynamoDB key string.** They come from
  `src/infrastructure/db/keys.ts`.
- **Never leave a list query unpaginated.** A single Query page caps at 1MB and silently
  truncates. Use `queryAll()`.
- **A new execution entry point calls `executeProjectStream`** (or `executeProject` for a
  collected, non-streaming answer) rather than re-encoding the `projectType` dispatch, and
  opens the run bracket. Three call sites used to answer that question for themselves, and
  the two non-streaming routes had already diverged on the image case. A surface that calls
  `executeAgent` directly — chats, Slack, `/agent` — gets the same answer from the facade,
  which **refuses a non-agent project**: the loop has nowhere to put an `llm` project's
  `userPromptTemplate` and would answer from a bare system prompt *successfully*, and an
  image project's model does not serve completions. `/agent` was the one caller with no
  check of its own.
- **Stream author contract.** Top-level chunks are unauthored; only subagent chunks carry
  `author`. Filter with `isTopLevelChunk()` — never re-derive.
- **Chat persistence is flattened but tool traffic *is* replayed**, and the replay has three
  traps: storage order within a turn is the *reverse* of the wire order, call/result pairing
  is scoped to one run (ids are unique only there), and three separate budgets bound the
  context — only the history budget warns; a truncated tool result carries an inline
  `…[truncated]` marker, and turns past the replay window drop silently by design. Read
  `src/application/chat/AGENTS.md` before
  changing `run.ts` or `messageMapping.ts`; the mechanics are in
  [ARCHITECTURE.md](docs/ARCHITECTURE.md#chat).
- **Never restate an image cap locally.** Caps live in `src/domain/llm/imageLimits.ts` (client
  composers, API bodies and Slack all read them) and the `data:` encoding in
  `imageDataUrl`/`parseImageDataUrl`. Copies of either had already drifted apart once.
  Documents have their own caps in `src/domain/llm/documentLimits.ts`, kept separate because
  they bound a different thing: an image is bounded by what a provider accepts, a document by
  the prompt its text has to fit and by the 400KB item a chat message is stored as.
- **An attachment that is not an image becomes text, at the surface that received it.** A
  model id here may be served by the default router or by its own provider's
  OpenAI-compatible endpoint, and those disagree about file content parts — while capability
  is modelled per *model*, which cannot express a difference that belongs to the channel.
  Text needs no capability gate and survives persistence, replay and the PII filter unchanged.
  `src/application/llm/documentParts.ts` owns the framing; extraction is a port
  (`DocumentExtractor`) because it needs a PDF parser.
- **Bytes are text only when they really are.** `Buffer.toString("utf-8")` never throws — it
  turns a PDF into replacement characters and reports success — so `decodeUtf8Text`
  (`src/shared/utf8Text.ts`) decides, and a caller that cannot use the answer says what it
  dropped. A `try/catch` around a decode is the shape of the bug, not a guard against it.
- **Report what was lost.** Truncation goes in the tool-result text; a binding that could not
  be used, a truncated transcript, a dropped history run — all become `warning` chunks. Silent
  loss is the bug, not the truncation.
- **Tests mock at boundaries**: `fetch` via `vi.stubGlobal`, the DynamoDB doc client via
  `vi.mock("@/infrastructure/db/client")`. Keep them deterministic — no real `Date.now`,
  timers, randomness, or network. Repository integration lives in
  `scripts/integration-check.ts`, run against a local DynamoDB in its own CI step, outside
  vitest.
- **Secrets on update**: a masked or empty value preserves what is stored; a masked value with
  no stored counterpart is dropped. A mask can only confirm a secret, never create one.
- **The two repo syncs own opposite ends.** `SKILLS_REPO` overwrites — a skill is its
  document. `TOOLS_REPO` only ever creates: an MCP entry also carries encrypted headers and an
  OAuth block discovered from the server, so an existing name is left untouched and reported as
  `skipped`. Making the tools sync upsert "for consistency" destroys credentials.
- **A repo sync imports and reports; it never overwrites or deletes on its own.** Both syncs
  (`syncSkillsFromSnapshot`, `syncToolsFromSnapshot`) create what is missing and report the
  rest — what a document would change, and what the repository no longer carries. Either is
  acted on only when a caller names it, because the stored version may be a deliberate edit
  and an entry may hold credentials. Only entries a sync created are listed as orphaned; one
  someone registered by hand was never the repository's to miss. **A deletion a sync performs
  goes through the use case and names the person who asked for the sync** — both syncs take a
  required `actorEmail` for that reason, since `remove` is the single owner of the
  `registry.delete` row and a deletion around it leaves no trace at all.
- **Docs record the current state, not history.** Completed milestones are deleted from
  `docs/MILESTONES.md`; git log and the per-tag GitHub Release are the record. Do not
  accumulate changelogs in comments or docs.
