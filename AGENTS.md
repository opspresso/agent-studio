# AGENTS.md

Working rules for coding agents in this repository (`CLAUDE.md` is a symlink to this file).

AgentDure is a single Next.js 16 full-stack app: an internal LLM platform for
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

# Integration check — a *separate* instance on :8084 and the `agentdure-test`
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
  it **must not import `container.ts`** — deps are injected, never pulled. Third-party
  packages are banned outright, not by blocklist: **the domain and the standard library, and
  nothing else**, with `@a2a-js/sdk` the one named exception (the A2A protocol *is* the
  contract, and a port would restate its task lifecycle to gain nothing). A second SDK is
  argued for in `tests/architecture.test.ts`, next to that one.
- `src/infrastructure/` — adapters: DynamoDB repositories, LLM channel, MCP client, Slack,
  A2A, GitHub, net/crypto helpers.
- `src/app/` — App Router pages + API route handlers. **Do not import `infrastructure/`
  directly**; get repositories and `executionDeps` from a wiring site. A **`"use client"`
  file may not import `application/` or `infrastructure/` at all** — the boundary there is
  the runtime it compiles for, not the directory it sits in, so the rule reads the
  directive. A pure helper both a client and a use case need goes to `src/shared/`, which
  is what `template.ts` did; reaching across instead is how the engine ends up in the
  browser bundle.
- `src/lib/` — cross-cutting glue: composition root, auth, session, config, runtime-settings.
  Infrastructure may import it; application may reach only its pure leaves (today
  `runMetrics`); domain never touches it.
- `src/shared/` — dependency-free helpers. The bottom of the graph: it imports nothing from
  `@/`. Before adding here, ask whether the helper is really domain vocabulary — a name
  rule, a format a domain type owns: that belongs in `domain/`, which is pure TS and
  client-bundle-safe, so "a client component needs it too" is never by itself a reason to
  put a rule at the bottom. `shared` is for helpers no layer owns (stream plumbing, text
  cutting, timers).

Composition happens at exactly five wiring sites: `src/lib/container.ts` (repositories, the
domain ports, the registry-slice singletons, `executionDeps`/`imageDeps`),
`src/app/api/chats/_deps.ts` (`ChatDeps`), `src/app/api/slack/events/_lib/`
(`SlackEventDeps`), `src/app/api/a2a/[name]/route.ts` (per-request A2A SDK
handler assembly over `executionDeps`), and `src/instrumentation.ts` (the boot path, which
wires the audit sink straight from its adapter — the composition root is not loaded until
this file decides the runtime is the Node server — and resumes the managed MCP containers).

**A use case is composed once, not per route.** A slice exports a `createXUseCases` factory,
the composition root calls it, and a route handler imports the bound object — which is what
keeps the wiring-site list above at five. The free functions those factories wrap stay
exported, and the split between the two forms is not a preference: **a route takes the bound
object; an application module that already holds the repository calls the function.** A use
case passing its own injected repository to a sibling in the same layer is ordinary; a route
handler choosing which repository, which cipher, or which registry lookups a version's
references are validated against is the presentation layer making a composition decision.
Twenty of them did, and nothing said so, because importing a repository from the composition
root breaks no rule above. `REPOSITORIES_THE_ROUTES_NO_LONGER_COMPOSE` in
`tests/architecture.test.ts` now keeps the converted ones out of `src/app`; a name is added
to that list as its slice is converted, never before.

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

**Which layer owns a limit** is a question the table answers case by case, so the rule behind
it: **a cap something else imposes on us belongs in `domain/`; a cap we chose belongs beside
the mechanism that spends it.** An image size, a document's extracted characters and the tool
count one request may declare are all a provider's or a stored item's number — a run only
discovers them. The turn ceiling, the subagent depth, the transfer transcript budget and how
many tool calls run at once are this platform's own policy, and each is read by exactly the
loop that enforces it. `MAX_MCP_TOOLS_PER_RUN` sat on the wrong side of that for a while: the
ceiling it answers to is OpenAI's 128, not one anyone here picked — it sits at 120 only
because the engine's builtins are added after the MCP tools are cut and need the room.

| Decision | Owner |
|---|---|
| The shape of an MCP tool | `src/domain/mcp/types.ts` |
| Which hosts may skip the outbound URL guard | `src/domain/mcp/types.ts` |
| The address a project's client ID metadata document is served at | `clientMetadataUrl` in `src/application/mcp/mcpAuthUseCases.ts` — drift here is fatal by specification: an authorization server refuses when the document's own `client_id` differs from the URL it fetched |
| Interpreting `plugin.json`/`mcp.json`, and which MCP transports a plugin may bind | `src/domain/plugin/types.ts` |
| The Agent Plugins name rule | `isPluginName` in `src/domain/plugin/types.ts` |
| Which storage errors mean a lost conditional write | `src/application/errors.ts` |
| How an audit row is written | `src/application/audit/recordAudit.ts` |
| Collapsing an image model's three token counts into a usage row | `src/domain/llm/models.ts` |
| How an artifact row is written | `src/application/artifact/storeArtifact.ts` |
| The object key an artifact is stored under | `artifactObjectKey` in `src/domain/artifact/types.ts` |
| Deleting a stored object | `src/infrastructure/storage/s3ObjectStore.ts` |
| Constant-time secret comparison | `src/shared/timingSafe.ts` |
| Parsing a comma-separated config list | `src/shared/parseList.ts` |
| Whether a configured value is blank | `src/shared/env.ts` |
| Asking a provider for an embedding | `src/infrastructure/llm/embeddings.ts` |
| Reaching Bedrock | `src/infrastructure/llm/bedrockClient.ts` |
| What a model is, and which routes serve it | `MODEL_FAMILIES`/`MODEL_OFFERINGS` in `src/domain/llm/models.ts` |
| Talking to the vector store | `src/infrastructure/vector/s3VectorsStore.ts` |
| The key a capability is indexed under | `capabilityKey` in `src/domain/catalog/types.ts` |
| What text a capability is embedded as | `capabilityText` in `src/domain/catalog/types.ts` |
| How much a search may add to one run | `DISCOVERY_LIMITS` in `src/application/execution/bindings.ts` |
| What a run searches the catalog with | `discoveryQueries` in `src/application/execution/bindings.ts` |
| Parsing a markdown frontmatter block | `src/shared/frontmatter.ts` |
| The subagent nesting limit | `src/application/execution/subagentRunner.ts` |
| The per-run MCP tool cap | `src/domain/llm/toolLimits.ts` |
| What each member tier may spend | `TIER_LIMITS` in `src/domain/member/tiers.ts` |
| What a 401 from an MCP server means | `src/infrastructure/mcp/session.ts` |
| The name a provider will accept for an MCP tool | `src/infrastructure/mcp/toolManager.ts` |
| The header that names the calling project to an MCP server | `TENANT_ID_HEADER` in `src/application/execution/mcpTools.ts` |
| How many agents one dispatch may run | `src/application/llm/agentAssembly.ts` |
| How an agent run's prompt and tool set are assembled | `assembleAgentRun` in `src/application/llm/agentAssembly.ts` |
| Deriving a run's context budget from the model's window | `src/application/llm/contextBudget.ts` |
| Whether a run's trace is sampled | `src/application/run/traceLifecycle.ts` |
| Evaluating when a schedule fires | `src/domain/trigger/cron.ts` |
| Where a project's webhook is delivered | `projectWebhookPath` in `src/domain/trigger/types.ts` |
| The managed-workload name rule | `MANAGED_NAME` in `src/shared/slug.ts` |
| Merging concurrent generators | `src/shared/mergeGenerators.ts` |
| Deriving the transfer chain a chunk came from | `src/app/_lib/authorPaths.ts` |
| A dollar amount, written for a person | `formatUsd` in `src/app/_lib/formatUsd.ts` — enforced as its own rule rather than as a `SINGLE_OWNERS` row: no `${…toFixed(…)}` anywhere in `app` but the two `_lib` formatters |
| A stored object's size, written for a person | `formatBytes` in `src/app/_lib/formatBytes.ts` |
| Deriving why a run ended from its chunks | `chunkTermination`/`runTermination` in `src/domain/llm/types.ts` |
| Collecting what a run lost from its chunks | `collectedWarning` in `src/domain/llm/types.ts` |
| The 401 response body | `src/shared/unauthorized.ts` |
| The code a refused sign-in is identified by | `src/shared/signInError.ts` |
| Writing to the console | `src/shared/logger.ts` |
| What wraps a top-level run | `src/application/run/runBracket.ts` |
| Which project type runs which way | `src/application/execution/deps.ts` |
| Whether a run's prompt may name its caller | `callerFor` in `src/application/execution/deps.ts` |
| What a tool result has to do, and in what order | `createToolResultEmitter` in `src/application/llm/toolResultBudget.ts` |
| How the execution facade dispatches an agent project | `src/application/execution/deps.ts` |
| How a Slack reply is delivered, progress included | `src/application/slack/replyStream.ts` — one report, rendered by whichever mechanism the surface has: a DM's status line or a channel stream's `task_update` axis. Neither is the definition of the other |
| The Slack Web API surface a run uses | `SlackClientPort` in `src/application/slack/types.ts`; the streaming chunk shapes it passes are `SlackChunk` in `src/domain/slack/types.ts`, which is where the adapter can also reach them |
| Deciding whether bytes are UTF-8 text | `src/shared/utf8Text.ts` |
| User-document caps | `src/domain/llm/documentLimits.ts` |
| How a fetched URL is framed in a turn | `framedFetchedUrl` in `src/application/llm/documentParts.ts` |
| How much of a fetched URL is kept | `MAX_FETCHED_TEXT_CHARS` in `src/application/llm/urlContent.ts` |
| How an attached document is framed in a turn | `src/application/llm/documentParts.ts` |
| The name every entry is addressed by | `isSlug` in `src/shared/slug.ts` |

Other decisions with a single owner that the test cannot express as a pattern, but that the
same rule applies to:

| Decision | Owner |
|---|---|
| Every DynamoDB key string | `src/infrastructure/db/keys.ts` |
| Detaching a stream from the consumer that walked away | `src/shared/detachOnReturn.ts` |
| Reading an HTTP body under a byte ceiling | `src/shared/httpBody.ts` |
| The name and media type a tool's file is carried under | `safeFileName`/`baseMediaType` in `src/infrastructure/mcp/toolManager.ts` |
| Keeping a background timer from holding the process open | `src/shared/unrefTimer.ts` |
| Paginated list reads | `queryAll()` in `src/infrastructure/db/query.ts` |
| Which pages are public | `src/proxy.ts` |
| Whether a chunk is top-level | `isTopLevelChunk()` in `src/domain/llm/types.ts` |
| Which version a run executes | `resolveRunnableVersion` in `src/application/project/` |
| User-image caps | `src/domain/llm/imageLimits.ts` |
| `data:` image encoding | `imageDataUrl`/`parseImageDataUrl` in `src/domain/llm/types.ts` |
| Turning a stored image reference into an address | `resolveImageUrl` in `src/domain/chat/imageRefs.ts` |
| Turning a stored file reference into a download address | `resolveFileUrl` in `src/domain/chat/fileRefs.ts` |
| Offering a file a run produced to a reader | `src/application/artifact/producedFiles.ts` — the test enforces the *pairing* (a module reading one output axis reads the other) and exempts this file by name, since its whole subject is the axis |
| Signing an outbound request for AWS | `src/infrastructure/llm/awsSigner.ts` — pinned by `tests/awsSigner.test.ts` instead, which fixes the signature it produces |
| How long a signed object URL lives, per reader | `src/application/artifact/urlTtl.ts` |
| Who releases a chat's run lease | `teeToRunLog` in `src/application/chat/runLog.ts` |
| How a chat run reaches the browser | `src/app/api/chats/_lib/detachedRun.ts` |
| Row TTLs | `src/infrastructure/db/ttl.ts` |
| The UTC day a usage row is keyed by | `utcDay` in `src/shared/date.ts` |
| What a repo sync did, and what it left to a person | `src/domain/sync/types.ts` |
| The brand palette and component defaults | `src/app/theme.ts` |
| Who owns the chat viewport while a reply streams | `useStickToBottom` in `src/app/chats/_components/ChatThread.tsx` |
| Pairing a tool call with the result that answered it | `src/app/_lib/toolPairs.ts` |
| Drawing one tool's traffic as one row | `src/app/_components/ToolRow.tsx` |
| What a tool call reads as to a person | `describeTool` in `src/app/_lib/toolCalls.ts` |
| Every string the console shows a person | `src/app/_i18n/messages/en.ts` |
| Which language a request is served in | `src/app/_i18n/locale.ts` |

## Subsystem map

One line each — the linked section is the authority.

- **LLM engine** (`src/application/llm/engine.ts`) — pure logic with **everything injected**
  (channel, `recordUsage`, `callMcpTool`, `loadSkillContent`, `runSubagent`, `generateImage`,
  `editImage`), so it tests with no network or DB via `tests/fakeChannel.ts`.
  `src/application/execution/runProject.ts` is the composition point that resolves a version's
  skills/MCP tools/subagents and assembles those deps.
  → `src/application/llm/AGENTS.md`, then
  [ARCHITECTURE.md](docs/ARCHITECTURE.md#llm-engine)
- **Run bracket** — the single owner of what wraps a top-level run: the unknown-model refusal
  (ahead of the guards, and a 400 — it says the version is misconfigured, not that the
  platform is busy), the in-flight metric, the cost guard, the per-caller concurrency guard,
  the correlation id. Exactly four functions admit a run. →
  [ARCHITECTURE.md](docs/ARCHITECTURE.md#the-run-bracket)
- **Images** — four producers (an `image` project, an agent run's builtins, an image
  subagent, an MCP tool that returned one) over one `ImageChannel` port; source bytes decide
  edit vs generate, and `toImageUsageRecord` is the one collapse into a usage row. →
  [ARCHITECTURE.md](docs/ARCHITECTURE.md#images)
- **Artifacts** — what a run left behind. Captured at the **run bracket**, not at the image use
  case: all four producers converge on `EngineChunk.image`, and only the first of them is that
  use case. One row per stored object, reachable by project (GSI1) *and* by person (GSI2,
  sparse) — a Slack or trigger run names no mailbox, so the project axis is the only way its
  output is ever listed or deleted. →
  [ARCHITECTURE.md](docs/ARCHITECTURE.md#artifacts)
- **Reading a URL** — the `FetchUrl` builtin, off unless a version opts in. It owns no
  extraction: text, HTML and PDF all pass through the same `DocumentExtractor` an attachment
  does. The adapter that fetches it is the **only** place an address the *model* chose is
  requested, and the rules there are load-bearing rather than defence in depth. →
  [SECURITY.md](docs/SECURITY.md#urls-the-model-chose)
- **Single-table DynamoDB** — one table, `PK`/`SK` + `GSI1`/`GSI2`; usage rows are daily
  per-project-per-model maps updated with atomic `ADD`. →
  [ARCHITECTURE.md](docs/ARCHITECTURE.md#dynamodb-single-table-design)
- **Auth & authorization** — `withAuth`/`withAdminAuth` for routes, `src/proxy.ts` for pages;
  projects are a shared catalog with owner/admin-gated mutations. **`isAdminEmail` and
  `isConfiguredAdmin` are not interchangeable.** →
  [SECURITY.md](docs/SECURITY.md#authorization-model)
- **Secrets** — AES-256-GCM at rest (`enc:v1:`), masked on read, four revealable via POST.
  → [SECURITY.md](docs/SECURITY.md#secrets-at-rest)
- **Runtime settings** — DB override → env fallback, cached process-locally. Never read those
  env vars directly at dispatch; go through `src/lib/runtime-settings.ts`. →
  [CONFIGURATION.md](docs/CONFIGURATION.md#resolution-order)
- **MCP** — one session owner, an adapter over `@modelcontextprotocol/client` that **probes
  each server's protocol era** (`2026-07-28`, or the `initialize` handshake for one that has
  not moved) and gets its OAuth client the same way — metadata document first, RFC 7591
  registration behind it. Both halves of that are backward compatibility on purpose: a
  registry entry points at somebody else's deployment, so pinning the revision or dropping
  registration breaks a working entry for a reason its owner cannot fix. Discovery cached per
  `url + headers`, managed servers on loopback by provenance, per-project OAuth connections.
  The SSRF guard, the response byte ceiling, the lazy connect and the expired-session retry
  are the session's own; the SDK supplies none of them. **The SDK is pinned to an exact
  version** — `2.0.0`, no caret, beside `next` and `react` — because four of its behaviours
  are load-bearing here and none is covered by semver: which revision
  `LATEST_PROTOCOL_VERSION` names (a bump into the 2026 era makes the handshake fallback
  useless), what `mode: "auto"` falls back to, that `listMaxPages` throws rather than
  truncating, and the `SdkErrorCode` values `unusableServerReason` reads. Widening it to `^`
  is a protocol change, not a dependency update. →
  [ARCHITECTURE.md](docs/ARCHITECTURE.md#mcp)
- **Capability catalog** — one global index (skills, MCP servers *and* their tools, external
  agents) rebuilt by a CronJob tick, never on a registry write. A version opting into
  `dynamicCapabilities` has its lists **widened** before resolution, from the system prompt and
  the request; bindings are never displaced, and an OAuth-bearing MCP server is added only
  where the project has already connected it. Off entirely without `VECTOR_BUCKET`. →
  [ARCHITECTURE.md](docs/ARCHITECTURE.md#capability-catalog)
- **PII filtering** — opt-in per version; bounds what the LLM and engine context see, **not**
  what an MCP server receives, and **not** the request text capability discovery embeds (that
  search runs before the engine constructs the filter). →
  [SECURITY.md](docs/SECURITY.md#pii-filtering-and-where-it-stops)
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
- **Resolving a version's tools without `discoveryQueries` silently disables discovery.**
  `resolveRunTools` takes its queries as an optional fourth argument, so a caller that omits
  them gets a run where the version's `dynamicCapabilities` still reads as on, the bindings
  still resolve, and nothing says the search never happened. Two of the three call sites
  shipped that way — a transferred-to child ran on its bindings alone, and the preview
  described a smaller prompt than the run it stands for. `TOOL_RESOLUTION_SITES` in
  `tests/architecture.test.ts` bounds the list and checks each one names the helper; a fourth
  is added there on purpose.
- **A new execution entry point calls the facade** rather than re-encoding the `projectType`
  dispatch, and opens the run bracket. Which one says what the surface can render:
  `streamProjectRun` for a consumer that takes a run as chunks, image included;
  `executeProjectStream` / `executeProject` for one that answers with a completion, which
  **refuse an image project** — an image has no chat completion, so there is no answer to
  send. A trigger has one: the picture is billed, traced, and recorded on the firing's row,
  even though the row carries text and the bytes stop there. That pair is two contracts,
  not a flag; a boolean deciding whether a project type is refused would be the bug the
  refusal prevents. Three call sites used to answer the dispatch question for themselves, the
  two non-streaming routes had diverged on the image case, and a fourth copy lived in the
  composition root. A surface that calls `executeAgent` directly — chats, Slack, `/agent` —
  gets the same answer from the facade, which **refuses a non-agent project**: the loop has
  nowhere to put an `llm` project's `userPromptTemplate` and would answer from a bare system
  prompt *successfully*. `/agent` was the one caller with no check of its own.
  **Those three are a bounded list, like the image one** (`AGENT_RUN_ENTRY_POINTS` in
  `tests/architecture.test.ts`), because the cost of `executeAgent` being safe to call
  directly is that *how a run is entered* has three homes while *which project type runs
  which way* has one. A policy belonging at the entry — a per-surface input cap, a rate
  limit — has to be put in all three, so a fourth is added on purpose.
- **The image use case has a bounded caller list, not an owner.** Three surfaces reach
  `application/image/generateImage` directly because each answers in a shape no other can
  (chunks, `{ imageBase64, model, usage }`, an A2A `image` artifact);
  `tests/architecture.test.ts` names them, so a fourth is added on purpose. A surface that
  only needs chunks belongs behind `streamProjectRun`.
- **`caller` reaches the prompt through `callerFor`, and nowhere else.** The version's
  `callerContext` opt-in is the gate, applied once at the engine-input boundary; the facade
  forwards the caller unconditionally through `toRunInput`. Two dispatch points rebuilding
  the executor's input per branch is how it got dropped for `/predict` and
  `/chat/completions` while working on every surface that calls `executeAgent` directly.
  **A transfer carries it too**, on `RunOrigin` beside the actor — a child is answering the
  same person as its parent — and the child's own `callerContext` decides its own prompt. The
  field said so from the day it was written while nothing populated or read it, so a child
  that opted in ran anonymously: the checkbox on, the block missing, nothing saying so. Both
  child prompt assemblies (`runLocalSubagent`, `runPromptSubagent`) go through `callerFor`.
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
- **A chat run outlives the connection that started it.** The browser hanging up means "the
  reader left", not "stop": the stream detaches (`src/shared/detachOnReturn.ts`), the run
  finishes and persists, and the reader can pick it back up. Three things follow, and each
  one looks like tidying up to undo. **A chat route must not pass an `AbortController` to
  `sseResponse`** — that is the old behaviour, exactly. **The wrapper that detaches must be
  the outermost thing the response consumes**, because a plain `async function*` above it
  swallows the `return()` that carries the disconnect (`mergeGenerators.ts` says why). And
  **the client must not abort its `fetch` on unmount**, which is the same mistake from the
  other end. The one way to stop a run is `DELETE /api/chats/{id}/runs/{runId}`, which the
  run learns by polling — the instance serving the press is not necessarily the one running
  the answer.
- **Nothing in the chat view scrolls the viewport on its own.** A reply streams through the
  store dozens of times a second, so anything keyed on that — a `scrollIntoView` in an effect
  was the version that shipped — drags the reader back down every time they try to read what
  scrolled past, and `smooth` on top of it restarts its own animation before finishing, which
  is what "the screen bounces" turned out to be. `use-stick-to-bottom` owns the viewport
  instead: it follows only while the reader is already at the bottom, and the only thing that
  overrules them is sending a message. Three consequences. **The jump-to-latest control keys
  on `isNearBottom`, not `isAtBottom`** — the latter stays true until the library judges the
  reader *meant* to leave, and it skips that judgement entirely while content is resizing,
  which during a reply is always. **Nothing inside the thread may be a scroll container on
  both axes**: the library finds the viewport by walking up from whatever the pointer is over
  to the first `overflow: auto|scroll` ancestor, so a code block that is one swallows the
  wheel and the reader can never escape (see `.markdown pre` in `parts.module.css`). And the
  **store notifies on a collection window rather than per frame**, because each notification
  re-renders the thread; `MessageView` is memoised against reference-stable messages for the
  same reason, since re-parsing every message's markdown per token is what made the reply
  judder in the first place.
- **The chat run log is a buffer, not a record**, and it is written **only after the reader
  leaves** — while someone is attached they are seeing every frame already, so writing them
  down as well would cost a write every half-second of every run to serve the few that get
  abandoned. Its ordering is the contract a resume rests on: **persist → terminal entry →
  release the lease**, which is why the lease release lives in `runLog.ts` rather than in
  `runAndPersist`. Two consequences worth knowing before changing either: image bytes are
  never logged (a note goes in their place), and while a window is attached the log is empty,
  so a *second* window watching the same run sees nothing until the first one closes — which
  `replayRunLog` says out loud rather than showing as a stall.
- **Never restate an image cap locally.** Caps live in `src/domain/llm/imageLimits.ts` (client
  composers, API bodies and Slack all read them) and the `data:` encoding in
  `imageDataUrl`/`parseImageDataUrl`. Copies of either had already drifted apart once.
  Documents have their own caps in `src/domain/llm/documentLimits.ts`, kept separate because
  they bound a different thing: an image is bounded by what a provider accepts, a document by
  the prompt its text has to fit and by the 400KB item a chat message is stored as.
- **A run's bytes are kept at the bracket, never at the producer.** `openRun` is what all four
  entry points call, so the recorder is built there with the run's identity already bound.
  Attaching it to `generateImage` instead covers a quarter of the cases: the chat surface's
  images are mostly builtin and subagent output, which never pass through that use case.
  `ARTIFACT_CAPTURE_SITES` in `tests/architecture.test.ts` bounds the list, and a second check
  fails any `openRun` caller that does not also capture — a fifth entry point that forgot would
  drop its output silently, which is exactly how chat-only storage stayed invisible.
- **A file a tool produced is not an image, and the two axes travel together.**
  `EngineChunk.file` is its own axis because ten consumers know `chunk.image` and would upload
  a DOCX to Slack as a picture or draw it in an `<img>`. The asymmetry: a file's bytes **never
  enter the model's context** — no image budget, no fallback rule, no follow-up message — and
  they are stripped from the chunk once stored, since a download link is what a reader needs.
  Being its own axis is also how it went missing: the field was added for the chat view and
  reached nowhere else, so `/predict`, both OpenAI shapes, `/agent`, A2A, Slack, a trigger's
  history row and the console's Playground and compare view each read the image beside it and
  dropped the file. The document was stored and the caller was never told it existed. **A
  module that reads one output axis now reads the other**, which `tests/architecture.test.ts`
  enforces as a pairing rather than a list — what a surface *does* with each is its own
  business. `src/application/artifact/producedFiles.ts` owns turning a reference into an
  address, the sentence for one that could not be kept, and the `/agent` stream transform that
  swaps the object key for a signed URL on the way out.
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
- **Report what was lost — and only what was lost.** Truncation goes in the tool-result text; a
  binding that could not be used, a truncated transcript, a dropped history run — all become
  `warning` chunks. Silent loss is the bug, not the truncation. **A gain is not a warning**, and
  the channel stops meaning anything if it carries both: capability discovery reported what it
  *found* this way, so every healthy run of a version with it on raised a yellow alert on every
  turn. It returns `discovered` beside `warnings` now. `collectedWarning` owns what a run lost;
  a feature that is silently inert — a version asking for discovery where the deployment has no
  catalog — is a loss and does belong there.
- **Tests mock at boundaries**: `fetch` via `vi.stubGlobal`, the DynamoDB doc client via
  `vi.mock("@/infrastructure/db/client")`. Keep them deterministic — no real `Date.now`,
  timers, randomness, or network. Repository integration lives in
  `scripts/integration-check.ts`, run against a local DynamoDB in its own CI step, outside
  vitest.
- **Secrets on update**: a masked or empty value preserves what is stored; a masked value with
  no stored counterpart is dropped. A mask can only confirm a secret, never create one.
- **The plugins sync applies the repository; a person owns deletion.**
  `syncPluginsFromSnapshot` (`src/application/plugin/syncPlugins.ts`) pulls the Agent
  Plugins repo (`PLUGINS_REPO`) into both registries at once. **A name a plugin declares is
  the repository's**: whatever the stored entry's origin — this repo, a retired one, or a
  hand registration with no `source` at all — it is brought to the repository's version
  automatically on every sync, provenance rewritten with it and a `registry.adopt` audit
  row left behind. A console edit to a declared name is the anomaly, not the record; the
  one thing the sync never touches is a hand-registered entry whose name no plugin
  declares. **Credentials never follow an address**: a URL move drops stored headers and
  OAuth (`mcpUseCases.apply` owns that, `credentials-reset` reports it) — the repo decides
  where an entry points, never what it may authenticate as. An unreadable
  `plugin.json`/`mcp.json` freezes the plugin at its last row instead of orphaning its
  components, every write is fenced to a per-name `write-failed` skip, and what the
  repository no longer carries is only reported as orphaned — with the version bindings
  that would dangle — and deleted when the kind-qualified selection names it (managed
  entries through the managed use case, so the container stops with the row). **A deletion the sync
  performs goes through the use case and names the person who asked for the sync** — it
  takes a required `actorEmail` for that reason, since `remove` is the single owner of the
  `registry.delete` row and a deletion around it leaves no trace at all. Two asymmetries are
  load-bearing: skills write straight to the repository (that is how `files` and `source`
  survive), servers go through `mcpUseCases` (that is how every synced URL faces the SSRF
  guard); and headers declared in `mcp.json` are never imported — a secret does not belong
  in git — with the dropped names reported. `stdio`/`sse` servers are reported and skipped,
  never executed. The console's side of the same contract is
  `src/app/api/_lib/repoOwned.ts`, the single owner of the 403 a route answers when asked
  to edit or delete a repo-owned entry — a route-layer policy on purpose, because the sync
  reaches the same use cases and must stay able to.
- **The console speaks English and Korean, and the catalogue is TypeScript for a
  reason.** `src/app/_i18n/messages/en.ts` is the source of truth; `ko.ts` is typed as
  `Record<keyof typeof en, string>`, so a key added to one and not the other fails
  `pnpm typecheck` rather than rendering an English string inside a Korean page — there is
  no second tool keeping them in step. A client component reads `useT()`, a server one
  `await getT()`, and both resolve through the same `translator()`. **The language is a
  cookie, not a route segment**: a `[locale]` prefix would move 29 pages and 14 layouts and
  rewrite `src/proxy.ts`'s matcher and `PUBLIC_PATHS`, which is the single owner of which
  pages are public. Two things are deliberately *not* translated. **Error messages stay in
  English** — `AppError` carries its message as a string through `application` and
  `domain`, neither of which may import a framework, so translating them means giving every
  error a code and rewriting 69 throw sites; the console is internal and operators read
  them. And **product nouns stay in English in both catalogues** — Project, Skill, Agent,
  Tool, Plugin, Chat, Model, MCP are each an API resource and a URL segment, so a console
  that renamed its copy would make one thing answer to two words.
- **A timestamp is formatted with a locale, never without one.** `toLocaleString()` with no
  argument means the *runtime's* default, so the server writes `8/14/2026` where a Korean
  browser writes `2026. 8. 14.` — a hydration mismatch wherever a date reaches the first
  render, and a format that follows the browser rather than the language the reader chose.
  `formatDateTime`/`formatShortDateTime` (`src/shared/date.ts`) and `formatDate`
  (`src/app/_lib/formatDate.ts`) take it; call sites pass `useLocale()`. The parameter is
  optional only so `utcDay` and its neighbours — storage keys, not prose — stay unchanged.
- **Docs record the current state, not history.** Completed milestones are deleted from
  `docs/MILESTONES.md`; git log and the per-tag GitHub Release are the record. Do not
  accumulate changelogs in comments or docs.
