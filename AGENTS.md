# AGENTS.md

Working rules for coding agents in this repository (`CLAUDE.md` is a symlink to this file).

AgentDure is a single Next.js 16 full-stack app: an internal LLM platform for
prompt / agent / cost management (projects & versions, an LLM engine, agents
(subagents + external registry), skills, MCP tools, chats, cost dashboard).

**This file is the working contract — what to run, what not to break, and where a decision
lives.** It is not a description of the system; that is
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the per-subsystem files under
[docs/design/](docs/design/). When something here is a summary, the linked document is
authoritative and this file must not restate it — an entry below earns its place by being a
**trap an edit falls into**, not by explaining how something works.

| Need | Read |
|---|---|
| The shape every run passes through | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| The same shape as pictures | [docs/DIAGRAMS.md](docs/DIAGRAMS.md) |
| Why one subsystem decides what it does | [docs/design/](docs/design/) — one file each |
| Who owns a decision that must exist once | [docs/OWNERSHIP.md](docs/OWNERSHIP.md) |
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
additionally requires `ADMIN_EMAILS` and `ALLOWED_EMAIL_DOMAINS`, and `NODE_ENV=production`
(which the `Dockerfile` sets) refuses to boot without an explicit `STAGE`.

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
  Telegram, Teams, A2A, GitHub, net/crypto helpers.
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

Composition happens at exactly seven wiring sites: `src/lib/container.ts` (repositories, the
domain ports, the registry-slice singletons, `executionDeps`/`imageDeps`),
`src/app/api/chats/_deps.ts` (`ChatDeps`), `src/app/api/slack/events/_lib/`
(`SlackEventDeps`), `src/app/api/telegram/webhook/_lib/` (`TelegramEventDeps`),
`src/app/api/teams/messages/_lib/` (`TeamsEventDeps`),
`src/app/api/a2a/[name]/route.ts` (per-request A2A SDK
handler assembly over `executionDeps`), and `src/instrumentation.ts` (the boot path, which
wires the audit sink straight from its adapter — the composition root is not loaded until
this file decides the runtime is the Node server — and resumes the managed MCP containers).
Three `lib` modules besides the root reach one adapter each without composing a use case —
`auth.ts`, `runtime-settings.ts`, `memberAccess.ts` — and `tests/architecture.test.ts` names
exactly those as `lib`'s wiring modules; every other `lib` file is a leaf.

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

Each such decision has one owning file. `tests/architecture.test.ts` fails on a second copy
**and** on the owner losing the definition. Before writing any of these, check whether you are
about to make copy number two.

**Which layer owns a limit** is a question the list answers case by case, so the rule behind
it: **a cap something else imposes on us belongs in `domain/`; a cap we chose belongs beside
the mechanism that spends it.** An image size, a document's extracted characters and the tool
count one request may declare are all a provider's or a stored item's number — a run only
discovers them. The turn ceiling, the subagent depth, the transfer transcript budget and how
many tool calls run at once are this platform's own policy, and each is read by exactly the
loop that enforces it. `MAX_MCP_TOOLS_PER_RUN` sat on the wrong side of that for a while: the
ceiling it answers to is OpenAI's 128, not one anyone here picked — it sits at 120 only
because the engine's builtins are added after the MCP tools are cut and need the room.

**The list itself is [docs/OWNERSHIP.md](docs/OWNERSHIP.md)** — 108 decisions across two
tables, the second holding the ones the test cannot express as a pattern but that the same
rule governs. `tests/architecture.test.ts` is what enforces both.

## Subsystem map

One line each; the link is the authority. What is worth knowing *before* an edit is under
[Conventions that bite](#conventions-that-bite), not here.

- **LLM engine** — pure logic, everything injected, tested with no network or DB via
  `tests/fakeChannel.ts` → `src/application/llm/AGENTS.md`, then
  [design/execution.md](docs/design/execution.md#llm-engine)
- **Run bracket** — the one thing every top-level run passes through: model policy, cost guard,
  tier cap, concurrency slot, metric, correlation id, artifact recorder →
  [ARCHITECTURE.md](docs/ARCHITECTURE.md#런-브래킷)
- **Images** — three paths that draw meet at one `ImageChannel` port (an MCP tool's picture is a
  fourth producer and never touches it); source bytes decide edit vs generate →
  [design/execution.md](docs/design/execution.md#images)
- **Artifacts** — what a run left behind, captured at the bracket, one row per stored object →
  [design/execution.md](docs/design/execution.md#artifacts)
- **Reading a URL** — the `FetchUrl` builtin, off unless a version opts in; the one adapter that
  requests an address the *model* chose → [SECURITY.md](docs/SECURITY.md#모델이-고른-url)
- **Single-table DynamoDB** — one table, `PK`/`SK` + `GSI1`/`GSI2` →
  [ARCHITECTURE.md](docs/ARCHITECTURE.md#dynamodb-단일-테이블-설계)
- **Auth & authorization** — `withAuth`/`withMemberAuth`/`withAdminAuth` for routes,
  `src/proxy.ts` for pages;
  **`isAdminEmail` and `isConfiguredAdmin` are not interchangeable** →
  [SECURITY.md](docs/SECURITY.md#인가-모델)
- **Secrets** — AES-256-GCM at rest (`enc:v1:`), masked on read, four revealable via POST →
  [SECURITY.md](docs/SECURITY.md#저장된-시크릿)
- **Runtime settings** — DB override → env fallback; never read those env vars at dispatch, go
  through `src/lib/runtime-settings.ts` →
  [CONFIGURATION.md](docs/CONFIGURATION.md#해석-순서)
- **MCP** — one session owner over `@modelcontextprotocol/client`, probing each server's
  protocol era; discovery cached per `url + headers`; managed servers on loopback by provenance;
  per-project OAuth → [design/mcp.md](docs/design/mcp.md)
- **Capability catalog** — one global index rebuilt by a CronJob tick, never on a registry
  write; a version opting in has its lists widened, never displaced →
  [design/capabilities.md](docs/design/capabilities.md#케이퍼빌리티-카탈로그)
- **Memory** — lives behind MCP (mcp-memory), not in this app; `memoryRecall` asks `recall`
  before the first token → [design/capabilities.md](docs/design/capabilities.md#메모리)
- **PII filtering** — opt-in per version; bounds what the LLM sees, **not** what an MCP server or
  the catalog's embedding provider receives →
  [SECURITY.md](docs/SECURITY.md#pii-필터링-그리고-그것이-멈추는-곳)
- **SSRF guard** — operator URLs checked at registration *and* dispatch, through
  `fetchPublicUrl` → [SECURITY.md](docs/SECURITY.md#아웃바운드-요청-ssrf)
- **Messaging surfaces** — what every chat bot shares: `handleTurn` runs a normalised turn and
  delivers the reply through the `ReplyChannel` port; an adapter decides which events are for
  the bot, how history is read, who is asking, and how a reply is rendered →
  [design/messaging.md](docs/design/messaging.md)
- **Slack** — per-project bots; `classifySlackEvent` decides which received messages are for the
  bot **ahead of the dedup claim**; six read-only workspace tools behind an opt-in →
  [design/slack.md](docs/design/slack.md)
- **Telegram** — per-project bots on the same pipeline; a reply edited in place and split at
  4,096 characters, rendered once with a plain fallback; a transcript store because the Bot API
  hands back no history → [design/telegram.md](docs/design/telegram.md)
- **Teams** — per-project Azure Bot registrations on the same pipeline; the Bot Framework's
  token is the whole authentication (signature, issuer, audience, `serviceUrl`); Markdown
  natively, edits in place, the same transcript store → [design/teams.md](docs/design/teams.md)
- **A2A** — both directions; a transfer continues the remote conversation →
  [design/agents-a2a.md](docs/design/agents-a2a.md)
- **Triggers** — one webhook, any number of schedules, published-only, deduplicated by
  conditional claims; a CronJob ticks the scan → [design/triggers.md](docs/design/triggers.md)
- **Attribution** — `RunActor { kind, id }` names who caused a run; `RunOrigin` carries it down
  every transfer hop →
  [design/observability.md](docs/design/observability.md#사용량과-비용-귀속)
- **Errors** — `AppError` subclasses before a stream starts, `{error}` chunks after the first one
  → [ARCHITECTURE.md](docs/ARCHITECTURE.md#에러-처리)
- **Logging** — `src/shared/logger.ts` is the only writer (`domain`'s one bare `[cost]` warn
  excepted, since it imports nothing); lines carry the run's correlation id, deliberately *not*
  the sampled trace id → [OPERATIONS.md](docs/OPERATIONS.md#로깅)

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
  composition root. A surface that calls `executeAgent` directly — chats, Slack, Telegram,
  Teams, `/agent` — gets the same answer from the facade, which **refuses a non-agent project**: the loop has
  nowhere to put an `llm` project's `userPromptTemplate` and would answer from a bare system
  prompt *successfully*. `/agent` was the one caller with no check of its own.
  **Those five are a bounded list, like the image one** (`AGENT_RUN_ENTRY_POINTS` in
  `tests/architecture.test.ts`), because the cost of `executeAgent` being safe to call
  directly is that *how a run is entered* has five homes while *which project type runs
  which way* has one. A policy belonging at the entry — a per-surface input cap, a rate
  limit — has to be put in all five, so a sixth is added on purpose.
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
  [design/chat.md](docs/design/chat.md).
- **A chat run outlives the connection that started it** — the browser hanging up means "the
  reader left", not "stop" ([design/chat.md](docs/design/chat.md#런은-자기-연결보다-오래-산다)
  says why). Three edits look like tidying up and each one puts the old behaviour back. **A
  chat route must not pass an `AbortController` to `sseResponse`.** **The wrapper that
  detaches must be the outermost thing the response consumes**, because a plain
  `async function*` above it swallows the `return()` that carries the disconnect
  (`mergeGenerators.ts` says why). And **the client must not abort its `fetch` on unmount**,
  which is the same mistake from the other end.
- **Nothing in the chat view scrolls the viewport on its own** — `use-stick-to-bottom` owns
  it, and the reasoning is in [design/chat.md](docs/design/chat.md#런은-자기-연결보다-오래-산다).
  What that costs a change here: **nothing inside the thread may be a scroll container on both
  axes** or it swallows the wheel events the library follows (see `.markdown pre` in
  `parts.module.css`), and the **store notifies on a collection window rather than per frame**
  — `MessageView` is memoised against reference-stable messages for the same reason, since
  re-parsing every message's markdown per token is what made the reply judder.
- **The chat run log is a buffer, not a record.** Its ordering is the contract a resume rests
  on — **persist → terminal entry → release the lease** — which is why the lease release lives
  in `runLog.ts` rather than in `runAndPersist`. What it cannot do, and why it is written only
  after the reader leaves, is in [design/chat.md](docs/design/chat.md#런은-자기-연결보다-오래-산다).
- **Never restate an image cap locally.** Caps live in `src/domain/llm/imageLimits.ts` (client
  composers, API bodies and the messaging pipeline all read them) and the `data:` encoding in
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
  address, the sentence for one that could not be kept, and the raw-chunk stream transform
  (`withAddressedFiles`) that swaps the object key for a signed URL on the way out — applied by
  `/agent` and streaming `/predict`, a pair `RAW_CHUNK_STREAM_ROUTES` in
  `tests/architecture.test.ts` bounds because they have to agree.
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
- **An `@modelcontextprotocol/client` bump is a protocol change, not a dependency update.**
  Four of its behaviours are load-bearing and none is covered by semver: which revision
  `LATEST_PROTOCOL_VERSION` names, what `mode: "auto"` falls back to, that `listMaxPages`
  throws rather than truncating, and the `SdkErrorCode` values `unusableServerReason` reads.
  Check all four on any bump — a lockfile refresh included
  ([design/mcp.md](docs/design/mcp.md#transport-와-세션) says why each matters).
- **The plugins sync applies the repository; a person owns deletion.** The contract is
  [design/capabilities.md](docs/design/capabilities.md#skills) and, endpoint-side,
  [API.md](docs/API.md#레지스트리연동-오퍼레이션). Four things constrain a change to
  `syncPluginsFromSnapshot` (`src/application/plugin/syncPlugins.ts`). **A deletion the sync
  performs goes through the use case and names the person who asked for it** — hence the
  required `actorEmail`, since `remove` is the single owner of the `registry.delete` row and a
  deletion around it leaves no trace at all. **Two asymmetries are load-bearing**: skills write
  straight to the repository (that is how `files` and `source` survive) while servers go
  through `mcpUseCases` (that is how every synced URL faces the SSRF guard). **Headers declared
  in `mcp.json` are never imported** — a secret does not belong in git — with the dropped names
  reported. And the console's side of the same contract is `src/app/api/_lib/repoOwned.ts`, the
  single owner of the 403 a route answers on a repo-owned entry — a route-layer policy on
  purpose, because the sync reaches the same use cases and must stay able to.
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
  error a code and rewriting well over a hundred throw sites; the console is internal and
  operators read them. And **product nouns stay in English in both catalogues** — Project,
  Skill, Agent, Tool, Plugin, Chat, Model, MCP are each an API resource and a URL segment, so
  a console that renamed its copy would make one thing answer to two words.
- **A timestamp is formatted with a locale, never without one.** `toLocaleString()` with no
  argument means the *runtime's* default, so the server writes `8/14/2026` where a Korean
  browser writes `2026. 8. 14.` — a hydration mismatch wherever a date reaches the first
  render, and a format that follows the browser rather than the language the reader chose.
  `formatDate`/`formatDateTime`/`formatShortDateTime` (`src/shared/date.ts`) take it; call
  sites pass `useLocale()`. The parameter is optional only so `utcDay` and its neighbours —
  storage keys, not prose — stay unchanged.
- **Docs record the current state, not history.** Completed milestones are deleted from
  `docs/MILESTONES.md`; git log and the per-tag GitHub Release are the record. Do not
  accumulate changelogs in comments or docs.
