# Execution

What a project is, what a version declares, and what happens when one runs: the tool loop,
the three paths that draw a picture, and what a run leaves behind.

The shape this sits inside — layers, entry points, the run bracket, the `EngineChunk`
contract — is [ARCHITECTURE.md](../ARCHITECTURE.md). The caps named here are fixed in
[CONFIGURATION.md](../CONFIGURATION.md#limits-fixed-in-code).

> **The loop's own invariants live beside the code.** `src/application/llm/AGENTS.md` is the
> authority on what must hold when editing `engine.ts`, `agentAssembly.ts`,
> `toolResultBudget.ts` or `pii.ts`. This file says why the loop is shaped that way.

## Project / Version

```ts
Project { name (slug, immutable id), displayName, description,
          projectType: 'llm' | 'agent' | 'image', ownerEmail, departmentCode?,
          publishedVersion?, slack?, costLimits?, createdAt, updatedAt }

Version { projectName, versionName, systemPrompt, userPromptTemplate, model, fallbackModel?,
          parameters { temperature?, maxTokens?, reasoningEffort?, piiFiltering,
                       callerContext?, structuredOutput?/jsonSchema,
                       imageGeneration?/imageModel?, urlFetch?, slackWorkspace?,
                       dynamicCapabilities?, memoryRecall? },
          mcpList: McpBinding[], skillList: string[],
          subagentList: { name, type: 'local' | 'remote' }[], maxTurn?, createdAt }
```

- `CostLimits { alertThresholdUsd?, blockThresholdUsd?, monthlyAlertThresholdUsd?,
  monthlyBlockThresholdUsd?, alertSlackChannel? }` — two windows, the **UTC day** (the grain
  the usage row is keyed at) and the **UTC month**, whose spend is the sum of its daily rows —
  at most 31 in one partition, one bounded query — so no separate aggregate exists to drift.
- `McpBinding { name, headers?: Record<string, string | null>, tools?: string[] }` binds the
  version to a registry MCP server. `tools` narrows which of that server's tools the run
  offers. **The URL is always the registry's**; `headers` layers over the server's own headers
  at dispatch (string = replace/add, `null` = remove a default, matched case-insensitively),
  so one registry server serves many projects under different credentials. Override values
  carry the same AES-encrypt/mask lifecycle as registry headers — which makes a version the
  first entity holding secrets: API responses go through `toVersionView`, while execution
  paths read the repository value and decrypt at dispatch. Rows written before overrides
  existed stored `mcpList` as `string[]`; reads normalise them and the API still accepts that
  shape.
- Template variables `{{var}}` are rendered server-side before dispatch.
- Version writes validate **capability fit** for catalog models (agent projects require
  `capabilities.tools`; `structuredOutput` requires the capability). Unknown/custom model ids
  stay allowed with a warning — and are priced at $0 until added to the catalog.
- Version writes also validate that `mcpList`/`skillList`/`subagentList` entries **resolve**
  (`VersionRefRepos`, bound once into `versionUseCases` by the composition root), and that the
  project type can actually run them — only `agent` projects do, so a binding added to any
  other type is rejected rather than stored, shown in the editor and silently ignored at run
  time. On update only *newly added* entries are checked, so deleting a registry entry never
  strands the versions that already referenced it, and configuration stored before these
  rules stays editable and removable.
- **Which version a run executes** is owned by `resolveRunnableVersion`
  (`src/application/project/resolveRunnableVersion.ts`): the published pointer always wins;
  only interactive surfaces (chat) opt into falling back to the newest draft; external
  surfaces (Slack, A2A, webhook triggers, subagent transfers) are published-only, so drafts
  never leak.

## LLM engine

`src/application/llm/engine.ts` is **pure logic with everything injected** — channel,
`recordUsage`, `callMcpTool`, `loadSkillContent`, `runSubagent`, `generateImage`, `editImage`,
`fetchUrl`, `readSlack` — so it is tested with no network and no DB via `tests/fakeChannel.ts`.

The loop keeps two neighbours, and **`engine.ts` is the façade that re-exports both**, so a
caller keeps one import path and the split stays an internal one:

| Module | Owns |
|---|---|
| `agentAssembly.ts` | What a run is told it can do: `assembleAgentRun`, the system-prompt builders (`buildAgentSystemPrompt`, the skill and server tables, the run clock and caller blocks), the builtin tool definitions and `buildAgentTools`, `BUILTIN_TOOL_NAMES`, the `ImageRegistry`, and `MAX_DISPATCH_TASKS` |
| `toolResultBudget.ts` | What a result may cost and what it has to do: `createToolResultBudget` and `createToolResultEmitter`, `MAX_TOOL_RESULT_CHARS_PER_TURN`, `MIN_KEPT_RESULT_CHARS`, and the truncation marker |

> `src/application/llm/AGENTS.md` is the authority on the loop invariants. Read it before
> editing `engine.ts`, `agentAssembly.ts`, `toolResultBudget.ts` or `pii.ts`.

```mermaid
flowchart TB
  start["turn start"]
  guard{"turn ≥ maxTurn?"}
  turnlimit["warning +<br/>finishReason: turn-limit"]
  final{"turn = maxTurn − 1<br/>and this run has tools?"}
  wrapup["no tools offered,<br/>the model is told why"]
  call["model call — stream<br/>retryable failure before the first chunk:<br/>one fallback retry"]
  miderr["mid-stream failure:<br/>error chunk, no retry — stream ends"]
  hascalls{"tool calls?"}
  cut{"provider said<br/>finish_reason length?"}
  outputlimit["warning +<br/>finishReason: output-limit"]
  finished["done: true"]
  dispatch["announce every call, then dispatch:<br/>builtins in call order · MCP + FetchUrl concurrently ≤5<br/>an output-cut turn warns once; arguments that<br/>did not parse get an error result, never a dispatch"]
  budget["per-turn cap + run context budget<br/>a cut carries a marker, the run warns once"]
  append["ONE assistant message + tool results<br/>+ post-context messages — all charged"]

  start --> guard
  guard -->|yes| turnlimit
  guard -->|no| final
  final -->|yes| wrapup --> call
  final -->|no| call
  call -.-> miderr
  call --> hascalls
  hascalls -->|no| cut
  cut -->|yes| outputlimit
  cut -->|no| finished
  hascalls -->|yes| dispatch --> budget --> append -->|"turn + 1<br/>(a transfer: + 2)"| start
```

On the **wrap-up turn** every path ends in `turn-limit`: whatever the model wrote is the
run's answer, calls it made anyway are not dispatched, and the warning says whether the run
answered or stopped without one.

Every exit is announced — `done` for a finish, `finishReason` for a limit, an `error` chunk
for a failure — which is what lets consumers read the ending instead of inferring it.

- All text generation speaks the **OpenAI Chat Completions protocol**; model ids are
  `provider/model`. Routing is described in
  [CONFIGURATION.md](../CONFIGURATION.md#llm-channels).
- `runPrompt(deps, input): Promise<RunResult>` — single-shot, with `runPromptStream` for
  streaming.
- `runAgent(deps, input): AsyncGenerator<EngineChunk>` — the recursive multi-turn tool loop.
  What it may offer: `Skill` (progressive skill loading), `transfer_to_agent` (a subagent
  transfer — local recursion or a remote agent HTTP call), `dispatch_agents` (several
  subagents at once, offered to **top-level runs only** so the number of concurrent children
  does not grow with transfer depth), `GenerateImage`, `EditImage`, `FetchUrl` (a URL the
  model chose, behind `parameters.urlFetch` — see
  [SECURITY.md](../SECURITY.md#urls-the-model-chose)), and the six Slack read tools behind
  `parameters.slackWorkspace` (see [Reading the workspace](slack.md#reading-the-workspace)).
  **Any other name is an MCP tool**, and `BUILTIN_TOOL_NAMES` — all twelve — is reserved
  during alias allocation so an MCP tool never carries a name a builtin might claim.

> How the loop dispatches those, what a builtin being *offered* means and why it is never
> read off dep presence, how the turn guard and the wrap-up turn end a run, what a transfer
> carries and what every result is charged against — all of it is
> `src/application/llm/AGENTS.md`'s, in the detail an edit needs.

Three bounds are decisions about the platform rather than mechanics of the loop, and each
answers a question the loop cannot ask itself:

- The **run-wide context budget** (`src/application/llm/contextBudget.ts`, the single owner)
  derives a ceiling from the model's `contextWindow`, so a tool-heavy run on a small-window
  model truncates with a marker and one `warning` instead of dying on a provider `400` (the
  estimates and their rationale are in
  [CONFIGURATION.md](../CONFIGURATION.md#the-run-wide-context-budget)). It bounds what the run
  *adds* — the input `messages` stay the caller's: only chat trims history, its server-side
  store being the one unbounded input source, while every other surface relays what the caller
  composed, because silently rewriting a caller's request is worse than the provider's own
  overflow answer. An unregistered model has no window to derive from and runs unbudgeted.
- **Both image deps are injected only when the version opts in** via
  `parameters.imageGeneration`; the model is `parameters.imageModel` while that is still
  image-capable, else the registry's default. Whether the resolved model's provider implements
  the *edit* endpoint is knowable only at dispatch, so that refusal is a tool-result error
  rather than a hidden tool.
- **A local transfer carries an ancestry chain**: transferring to a project already on the
  chain, or nesting past depth 5, is refused as an authored error chunk. Turn accounting alone
  does not bound this — a child continues the parent's turn counter and its own `maxTurn` is
  clamped to the parent's ceiling (`subagentRunner.ts`) — but a cycle would still spend the
  whole budget before the ceiling said anything.

What a run carries past the loop itself:

- **Fallback**: on a retryable error (429/5xx) from the primary model **before the first
  chunk**, retry once with `fallbackModel`. A mid-stream failure yields an `{error}` chunk and
  does not retry.
- **PII filtering** (`parameters.piiFiltering`): emails, phone numbers, Korean registration
  numbers and Luhn-valid card numbers in outbound
  messages and variables are regex-masked with reversible format-preserving `[[PII:…]]` tokens
  before dispatch (`src/application/llm/pii.ts`); originals are restored in responses —
  streaming included, with token-boundary buffering — and the mapping carries across subagent
  transfers, while tool args/results re-entering engine context stay masked. **Outbound MCP
  dispatch is not masked** — see [SECURITY.md](../SECURITY.md#pii-filtering-and-where-it-stops).
  Off is byte-identical to the unfiltered path.
- **Cost** is what the channel charged when it says (`usage.cost_usd`, which a router reports
  and which alone matches the invoice), else registry pricing computed at the call site
  (`calculateCost` / `calculateImageCost` in `src/domain/llm/models.ts`); either way it is
  passed to `recordUsage`, which hands it to the usage repository's atomic `ADD`. Single-shot
  runs record per call; agent runs buffer per-turn usage in `createUsageAggregator` and flush
  once at run end.
- **Model registry** `src/domain/llm/models.ts`:
  `ModelConfig { id, provider, family, maker, displayName, pricing { inputPer1M, outputPer1M,
  cachedInputPer1M?, imageInputPer1M?, imageOutputPer1M?, perImage?, perInputImage? },
  capabilities { tools, structuredOutput, imageInput, reasoning, reasoningWithTools?,
  imageGeneration? }, contextWindow, maxTokens, hidden?, wireId? }`. See
  [CONFIGURATION.md](../CONFIGURATION.md#model-registry-families-and-offerings) for `wireId` and drift
  checking.

## Images

Three paths draw a picture, and they meet at one port — `ImageChannel`
(`src/domain/llm/imageChannel.ts`) — rather than at one use case, because what reaches them
differs: a route, a model's tool call, a transfer.

| Path | Runs in | Model |
|---|---|---|
| An `image` project | `generateImage` (`src/application/image/generateImage.ts`) | the version's own `model` |
| The `GenerateImage` / `EditImage` builtins of an agent run | `src/application/execution/imageTool.ts` | `parameters.imageModel` while it is still image-capable, else `DEFAULT_IMAGE_MODEL` — the first registry entry carrying the capability |
| An `image` project reached through a transfer | `runImageSubagent` (same file) | the child version's own `model` |

**Generating and editing is one decision, read off the input.** Every path calls `editImage`
when it holds source bytes and `generateImage` when it does not — the distinction the Images
API itself draws. That is what lets "now make it night" land on a picture the user attached,
one the run drew, or one a transfer handed to an image child through its `image_ids`, without
any of them needing a separate tool.

**The version's system prompt is its style.** An image provider has no system message, so
`composeImagePrompt` (`src/application/image/composeImagePrompt.ts`) prepends the version's
system prompt to every subject prompt — a caller's `prompt`, the rendered template, a
transfer's message — on the two paths that run an `image` project's version. The agent
builtins are the deliberate exception: an agent's system prompt is its behaviour, not a
picture style, so a builtin call sends the model's own prompt untouched. Style alone is not a
subject — a run with an empty subject prompt is still refused.

**Where the capability is checked decides what a refusal looks like.** `generateImage`
validates `capabilities.imageGeneration` and renders the prompt *before* opening the run
bracket, so a misconfigured version is a `400` rather than a run that spent a slot. The
builtins answer the same question at wiring time — a version that did not opt into
`parameters.imageGeneration` is never offered them, and a stored `imageModel` that has since
left the registry falls back to the default instead of silently disabling the tool. An image
subagent can only answer it mid-stream, so it does, as an authored `error` chunk. Whether the
resolved model's provider implements the *edit* endpoint is unknowable until dispatch, which
is why that refusal is a tool-result error rather than a hidden tool.

**The port states an intent; the adapter speaks each provider's dialect.** Unlike Chat
Completions — a de-facto standard every provider implements, which is why
`src/infrastructure/llm/channel.ts` has no provider branch at all — the Images API is *not*
one shape. `size` and `quality` on the port are the vocabulary the tool schema offers the
model, and a model knows nothing about which provider will serve it; translating them is
`src/infrastructure/llm/imageChannel.ts`'s job, and it is the one reader of
`ResolvedTarget.providerName`. xAI names the same intent `aspect_ratio` + `resolution`,
**refuses** unknown arguments rather than ignoring them (`400 Argument not supported: size`),
defaults `response_format` to a URL this adapter cannot use, and takes edits as
`application/json` only — its API documents the OpenAI SDK's multipart `images.edit()` as
unsupported, so that one call is hand-rolled over `fetch`. A provider added here needs its
dialect checked, not assumed: `tests/imageChannelAdapter.test.ts` pins each one's wire form.

**The mime type is read, never assumed.** It used to be hardcoded `image/png`, which held only
because that is OpenAI's default output format; xAI answers JPEG. The value is not cosmetic —
it becomes the S3 object's extension and `Content-Type` under an immutable cache header, the
`data:` prefix on bytes handed back to a *second* model, the Slack upload's filename and the
A2A artifact's type.

**Usage collapses in exactly one place.** An image model bills three token counts and a usage
row carries two; `toImageUsageRecord` (`src/domain/llm/models.ts`) owns that collapse for all
three paths. A provider that reports no token counts at all — xAI prices these per image and
says so as `cost_in_usd_ticks` — records zeros, and `calculateImageCost` falls back to the
registry's `perImage`, which is what is actually billed. Recording it is telemetry — the
provider has already drawn and billed the image, so a failed write is logged rather than
turned into a 500 that throws the result away.

**Where the bytes go is the consumer's decision, not the engine's.** The same `image` chunk
reaches every surface — how to read one is in the [EngineChunk contract](../ARCHITECTURE.md#enginechunk-contract)
— and each does something different with it: a chat persists the **object key** the run
bracket already stored under, Slack uploads to the thread once the run ends, the
OpenAI-compatible surface carries an `images` extension, predict returns them beside the text.
With no object storage configured a chat image renders during the live stream only, and says so
rather than leaving a gap.

**A stored image is a key, and its address is resolved per read.** The row never commits to an
access policy. `ARTIFACT_ACCESS_MODE=authenticated` resolves the key to a time-limited signed
URL; `public` resolves it to the direct regional S3 URL. An image is *shown*, so it asks for no
filename and the unsigned address is enough; a **document** is taken away under its own name,
which S3 will only accept on a signed request, so a document is pre-signed in either mode.
`resolveImageUrl`
(`src/domain/chat/imageRefs.ts`) owns the one compatibility rule — a `key` is resolved, a legacy
`url` is passed through — because two readers ask, and a second spelling is how one of them
quietly stops showing half the images. Both resolve *before* mapping, which is what keeps
`toEngineMessages` the pure synchronous function its replay contract is tested through.

In authenticated mode the two lifetimes differ for a reason that is easy to get backwards: a chat view is read by a
person who already has the page, so 15 minutes is generous, while a **replay** hands the URL to
the model *provider*, which fetches it at whatever point in a run that may last
`MAX_RUN_DURATION_MS`. The replay lifetime is therefore derived from the run deadline rather
than written down, or raising the deadline would silently start failing turns on images the
user can see in their own transcript. A third lifetime — seven days, the SigV4 ceiling —
serves a link written into something durable, a Slack thread or a stored A2A task, and is
read long after the run (`src/application/artifact/urlTtl.ts` owns all three). An image that
cannot be signed is dropped from the message: on the replay path an unfetchable URL fails the
whole turn.

**A chat never deletes an object.** A chat row expires by DynamoDB TTL, which the application
never observes, so there is no moment at which it could cascade — expiry is the bucket's
lifecycle rule, on the deployment checklist in
[OPERATIONS.md](../OPERATIONS.md#operational-checklist-for-a-new-deployment).

Deliberate removal is the artifacts gallery's, not this path's: an artifact row names the
object, and `artifactUseCases.remove` deletes the object *before* the row so a retry converges
(see [Artifacts](#artifacts)). A chat message keeps its own copy of the key, so an image
deleted there renders as unavailable in the transcript — said in the confirmation before the
fact, because a cascade back into every chat and Slack thread that showed it is not something
the artifact slice can do without importing them all.

## Artifacts

What a run left behind: one row per stored object, so the bytes can be listed, previewed and
removed. Before it there was no inventory at all — a generated image went to S3 under a random
UUID and its key was written into whichever chat message happened to be open, so nothing could
enumerate one, nothing could delete one, and a picture drawn by a trigger or an A2A call went
nowhere.

**Captured at the run bracket.** Four functions admit a top-level run and every one can produce
bytes, so `openRun` builds the recorder with the run's identity already bound — project,
version, actor, transfer chain, correlation id. Attaching it to `generateImage` instead would
have covered a quarter of the cases: an image reaches the stream from four producers (an image
project, the `GenerateImage`/`EditImage` builtins, an image subagent, an MCP tool that returned
one) and only the first is that use case. `captureRunArtifacts` wraps the engine's stream;
`generateImage` records its single result directly. A fifth source travels the same axis and is
the one capture skips: a picture `FetchUrl` brought back carries `fetched` and is delivered,
never kept — the run read those bytes rather than making them, and only that builtin sets the
mark, since an MCP tool's picture may as easily have been rendered as read.

| Chunk | What capture does |
|---|---|
| `image` | Stores the bytes, **keeps** them, adds `artifactId`/`key`. A live view still renders from the chunk. One marked `fetched` passes through unstored. |
| `file` | Stores the bytes and **strips** them, leaving name, size and key. A rendered document has nothing to draw, and pushing megabytes of base64 down an SSE connection to produce a download link is pure cost. |

A write that fails never fails the run: the picture was the expensive part, and losing the copy
is worth strictly less than losing the answer. The loss is reported once, **after** the stream,
as the run's true total — warning on the first failure would say "one file" and then absorb
every later one into the same one-shot flag.

**Two indexes, because each reaches rows the other cannot.**

| | PK | SK | GSI1 | GSI2 (sparse) |
|---|---|---|---|---|
| Artifact | `ARTIFACT#{id}` | `META` | `ARTIFACTPROJECT#{project}` / `{createdAt}#{id}` | `ARTIFACTOWNER#{email}` / `{createdAt}#{id}` |

An A2A, webhook or schedule run names no mailbox — its actor is a client id or a trigger — so
those rows are invisible to the owner index, and the project's own tab is the only place they
are ever listed or deleted. A Slack run's actor is a workspace user id, which the index cannot
key on either, but the surface can resolve the asker's address, so it does: the artifact is
filed under the person who asked for it (`ownerEmail`, kept beside the actor rather than
folded into it, since the actor key decides spend and limits). Projects being a shared
catalog, the reverse is also true: a person cannot find their own work by reading someone
else's project. `artifactOwnerEmail` decides, and writes no GSI2 attributes when the answer
is nobody.

The object key is derived from the row id (`artifacts/{kind}/{id}.{ext}`), which is what lets an
object and its row find each other; the legacy `images/{uuid}` keys reference nothing, so an
orphan under that layout can never be identified again. Splitting by kind is for the lifecycle
rule, which applies to a prefix. The storage adapter resolves every reader through the runtime
artifact access mode: a signed URL for a private bucket or a direct S3 URL for a public one.

**Deletion is object-first.** That order can only leave a row whose preview is broken — which
pressing delete again resolves, since S3 answers 204 for a key that is not there — while the
reverse leaves bytes no inventory names, permanently unreachable. Reading and deleting use one
predicate (the creator, else `assertProjectWritable`), because a different rule for each
produces a gallery listing rows whose delete button answers 403. Removing someone else's output
records `artifact.delete`; tidying up your own does not, since a row per deletion would bury
the acts the trail exists for.

Rows carry `expiresAt` on `ARTIFACT_RETENTION_DAYS`. That window and the bucket's lifecycle rule
are two independent settings the app cannot reconcile — see
[OPERATIONS.md](../OPERATIONS.md#row-retention).

