# ✨ Agent Studio

An internal LLM platform for prompt, agent, and cost management — one production-grade
Next.js full-stack application.

Build a prompt or an agent as a **project**, iterate on it in **versions**, publish one, and
call it from anywhere: the console, an OpenAI-compatible endpoint, Slack, a webhook, or
another agent over A2A. Every run is attributed, priced, and bounded.

## What's in it

| | |
|---|---|
| **Projects & versions** | Three project types — `llm` (single-shot prompt), `agent` (multi-turn tool loop), `image` (generate/edit). Versions are immutable snapshots; a pointer marks the published one. |
| **LLM engine** | One OpenAI-compatible protocol for every provider. Multi-turn tool loop, subagent transfers, per-turn budgets, single-retry fallback, streaming everywhere. |
| **Skills** | Markdown behaviour instructions loaded on demand — the system prompt carries only a name/description table. Syncable from a GitHub repo. |
| **MCP tools** | A shared registry of MCP servers; per-version bindings can narrow the tool list and override outbound headers. Managed servers and OAuth are supported (below). |
| **Agents** | Another project as a local subagent, or an external OpenAI-compatible / A2A endpoint as a remote one. |
| **Chats** | Private per-owner conversations against an agent project, with tool traffic and images preserved. |
| **Cost dashboard** | Daily per-project, per-model spend — plus per-caller attribution, because the project catalog is shared. |
| **Guards** | Per-project daily cost thresholds, per-caller concurrency limits, and a wall-clock deadline on every run. |
| **Integrations** | Per-project Slack bots, webhook triggers, and A2A in both directions. |

## Stack

- Node.js 24, pnpm 11
- Next.js 16 (App Router), React 19, TypeScript strict
- Mantine 9 (components + theme)
- Better Auth 1.6 + Google OAuth (custom DynamoDB adapter)
- Clean Architecture (`domain` / `application` / `infrastructure` / `app`), enforced by tests
- AWS DynamoDB single-table design

## Quick start

```bash
# 1. Install
corepack enable && corepack prepare pnpm@11.10.0 --activate
pnpm install

# 2. Environment
cp .env.example .env.local
# Fill in LLM_BASE_URL, LLM_API_KEY, AES_ENCRYPTION_KEY (32-byte base64),
# BETTER_AUTH_SECRET, and GOOGLE_CLIENT_ID/SECRET for real login.

# 3. Local DynamoDB
docker compose up -d dynamodb
pnpm init-local-table

# 4. Run
pnpm dev            # http://localhost:3000
```

No LLM provider or Google account handy? `scripts/mock-llm.ts` and `scripts/dev-session.ts`
cover both — see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#working-without-real-credentials).

> The DynamoDB Local containers are **shared with every other project on this machine**.
> Table names, not ports, keep them apart — never run `docker compose down -v`. Details in
> [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#local-dynamodb).

```bash
pnpm typecheck      # tsc --noEmit (strict)
pnpm test           # Vitest
pnpm build          # production build
```

There is no lint step; `typecheck` + `test` + `build` are the checks.

## Documentation

| Document | What it answers |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How it is built and **why** — layers, the single-table key map, the execution flow, domain semantics |
| [docs/API.md](docs/API.md) | Every HTTP route, its auth, and its request/response shapes |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every environment variable, and the limits fixed in code |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Deploying, probing, scaling, retention, alerting |
| [docs/SECURITY.md](docs/SECURITY.md) | Authentication, authorization, secrets, SSRF, PII |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Local setup, scripts, tests, CI |
| [docs/MILESTONES.md](docs/MILESTONES.md) | Remaining work (한국어) |
| [AGENTS.md](AGENTS.md) | Working rules for coding agents (`CLAUDE.md` is a symlink to it) |

## Feature tour

### Calling a project from outside

Each project's **API Reference** tab shows how, with the project's own name and published
version filled in and a copyable curl example per endpoint. Three execution endpoints are
available — `predict`, `chat/completions` (OpenAI-compatible), and `agent` (SSE) — plus the
A2A and Slack endpoints when those are configured.

Generate a token under **Project Settings → API token** and send it as
`Authorization: Bearer <token>` in place of the session cookie. It is scoped to that project
and authenticates as the owner. Full contract: [docs/API.md](docs/API.md#execution).

### Multiple LLM providers

All traffic speaks the OpenAI Chat Completions protocol, and model ids are `provider/model`.
By default every id goes to `LLM_BASE_URL` (a router such as OpenRouter or LiteLLM); register
per-provider channels to call providers directly. See
[docs/CONFIGURATION.md](docs/CONFIGURATION.md#llm-channels).

### Skills

Skills sync from a GitHub repo laid out as `skills/<name>/SKILL.md` — the parent directory is
the slug. Supporting files under a skill's directory (`references/*.md`, templates) are
collected as attachments and loaded on demand through the `Skill` tool's `file_path`. The repo
is the source of truth for synced skills; locally created ones are untouched.

### MCP tools

Register a server once on `/tools` and bind it from any version. A binding may narrow the tool
list and layer its own headers over the registry's, so one shared server serves many projects
under different credentials.

**Managed servers** — Agent Studio can start an MCP server container on its own host through
SSM and reach it on loopback, so a server with no public endpoint can still be used. It
repairs stranded containers automatically at boot, since replacing this app is exactly what
breaks them. Configure with `MANAGED_MCP_INSTANCE_ID` / `MANAGED_MCP_REGISTRY`; unset means
the feature is off rather than half-enabled.

**OAuth** — an admin runs discovery on a registry entry (RFC 9728 → RFC 8414), and each
project then holds its **own** credentials for it, so one shared entry can serve a different
provider app per project. PKCE S256, RFC 8707 `resource` and RFC 9207 `iss` are all enforced;
see [docs/SECURITY.md](docs/SECURITY.md#mcp-oauth).

### Images

**Input** — `chat/completions` accepts OpenAI content parts, a Slack mention's attachments are
downloaded and sent the same way, and the console's composer takes up to 4 images (5MB each,
`png`/`jpeg`/`gif`/`webp`) per turn. The version's model must have the `imageInput` capability,
otherwise the request is rejected rather than quietly losing the picture.

**Generation and editing** — `image` projects draw directly, and edit instead when source
images are attached. Agent runs can draw with the builtin `GenerateImage` tool and change an
existing image with `EditImage`, both enabled by a version's `imageGeneration` parameter.
`EditImage` addresses an image by a per-run handle (`img_1`, `img_2`, …) covering both what
the user sent and what the run drew, so "now make it night" works on either — and those
handles travel through a subagent transfer, so an agent can hand a picture to a dedicated
image project and get it *edited* rather than redrawn.

### Webhook triggers

An outside system starts a run by posting to a trigger's URL with its secret.

```bash
curl -X POST https://<host>/api/triggers/my-project/nightly \
  -H "X-Trigger-Secret: $TRIGGER_SECRET" \
  -H "Idempotency-Key: $EVENT_ID" \
  -d '{"event":"nightly-report"}'
```

Always runs the **published** version, answers `202` immediately and runs in the background,
deduplicates on `Idempotency-Key` for 24 hours, and refuses overlapping runs by default. Every
refusal — disabled, duplicate, busy, no published version — is a history row with a status, so
"it never fired" is distinguishable from "it fired and failed" without reading logs. See
[docs/API.md](docs/API.md#triggers).

### Slack

Each agent project can have its own Slack app. **Project Settings → Slack bot** generates a
project-specific manifest, and events on that project's URL are verified with its own signing
secret and always run that project — no selector needed. Replies stream into one message, a
mention inside a thread carries the thread as context, and image attachments are analyzed.

With Slack's **Agents** feature enabled, the app answers that surface natively: opening the
agent container shows the project's suggested prompts (up to four, edited in the same settings
panel), progress appears as Slack's own status line naming each tool rather than as edits to
the answer, a new thread is titled after the question that opened it, and the reply is a real
Slack text stream — falling back to editing one message where streaming is unavailable.

### A2A (Agent2Agent)

Both directions of the [A2A protocol](https://a2a-protocol.org) are supported. **Inbound**:
set `A2A_API_KEY` and every project with a published version serves a public Agent Card plus a
JSON-RPC endpoint. **Outbound**: register an agent with protocol `A2A` and its Agent Card URL,
then use it as a remote subagent.

Outbound URLs are operator-provided and SSRF-guarded, but any public URL is allowed — register
only trusted agents.

### PII filtering

Opt in per version. Emails and phone numbers are replaced with reversible,
format-preserving tokens before any LLM call and restored in the response, streaming included
— the model never sees the real values. It is regex-based and covers emails and phones only,
and **it does not mask what a connected MCP server receives**. Read
[docs/SECURITY.md](docs/SECURITY.md#pii-filtering-and-where-it-stops) before relying on it.

### Cost, attribution, and guards

Every run records **who caused it** — a user, a project token (as its owner), a Slack user, a
webhook, or inbound A2A — on the trace and on a per-caller daily usage row, because a shared
project catalog means the project name never answered "who spent this".

Each project can set a daily **alert** threshold (notify once, keep running) and a **block**
threshold (refuse every run until 00:00 UTC, with `Retry-After`). Separately,
`MAX_CONCURRENT_RUNS_PER_ACTOR` bounds how many runs one caller may have in flight. What each
guard does and does not bound is in
[docs/OPERATIONS.md](docs/OPERATIONS.md#spend-and-load-guards).

## Deployment

The build artifact is a container image.

```bash
docker build -t agent-studio .        # multi-stage, Next standalone output
docker compose up --build             # local container + both DynamoDB Local instances
```

Version tags (`v*`) build and push to ECR via GitHub OIDC and trigger a GitOps deploy. Point
the load balancer at `/api/ready` and restart checks at `/api/health`, scrape `/api/metrics`,
and enable DynamoDB TTL on the table's `expiresAt` attribute. The full checklist is in
[docs/OPERATIONS.md](docs/OPERATIONS.md#operational-checklist-for-a-new-deployment).
