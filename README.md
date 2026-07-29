# ✨ Agent Studio

LLM platform for prompt, agent, and cost management — a production-level single Next.js full-stack application.

Covered domains: **projects/versions, LLM engine, agents (subagents + external registry),
skills, MCP tools, chats, cost/usage dashboard**.

## Stack

- Node.js 24, pnpm 11
- Next.js 16 (App Router), React 19, TypeScript strict
- Mantine 9 (components + theme)
- Better Auth 1.6 + Google OAuth (custom DynamoDB adapter)
- Clean Architecture (`domain` / `application` / `infrastructure` / `app`)
- AWS DynamoDB Single Table Design

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the layer rules, single-table key map,
domain semantics, and API surface, and [docs/API.md](docs/API.md) for API request/response
examples and error cases.

## Quick Start

```bash
# 1. Install
corepack enable && corepack prepare pnpm@11.10.0 --activate
pnpm install

# 2. Environment
cp .env.example .env.local
# Fill in GOOGLE_CLIENT_ID/SECRET, BETTER_AUTH_SECRET, LLM_BASE_URL, LLM_API_KEY,
# AES_ENCRYPTION_KEY (32-byte base64: `openssl rand -hex 32`)

# 3. Local DynamoDB (dev instance on :8083; :8084 is the integration-test one).
# Both containers are shared with the other projects on this machine — the table
# name, not the port, is what keeps them apart. Never `docker compose down -v`.
docker compose up -d dynamodb
pnpm init-local-table
# Note: DynamoDB Local namespaces tables by access key + region; the init
# script uses the same region as the app client (AWS_REGION, default
# ap-northeast-2), so run both with the same AWS_REGION.

# 4. Run
pnpm dev            # http://localhost:3000
```

### Local development without real credentials

```bash
# Mock OpenAI-compatible LLM server (then set LLM_BASE_URL=http://127.0.0.1:8002/v1)
pnpm tsx scripts/mock-llm.ts

# Create a dev user + session and print a signed session cookie
# (bypasses the Google OAuth round-trip; local DynamoDB only)
pnpm tsx --env-file=.env.local scripts/dev-session.ts

# End-to-end integration check (repositories + engine against local DynamoDB).
# Runs against the :8084 instance and the `agent-studio-test` table, never the
# dev pair — it cascade-deletes what it writes, so do not pass
# --env-file=.env.local here (the script refuses).
docker compose up -d dynamodb-test
pnpm init-local-table:test
pnpm test:integration

# Seed sample skills (conversation, image-generation)
pnpm tsx --env-file=.env.local scripts/seed-skills.ts
```

### Multiple LLM providers

All traffic speaks the OpenAI Chat Completions protocol. By default every model
id goes to `LLM_BASE_URL` (a router such as OpenRouter or LiteLLM). To call
providers directly, register per-provider channels — model ids `provider/model`
then route to the matching channel with the prefix stripped:

```bash
LLM_PROVIDER_OPENAI_BASE_URL=https://api.openai.com/v1
LLM_PROVIDER_OPENAI_API_KEY=...
LLM_PROVIDER_GOOGLE_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
LLM_PROVIDER_GOOGLE_API_KEY=...
```

Set `LLM_PROVIDER_<NAME>_KEEP_MODEL_PREFIX=true` when the channel is itself a
router that expects full `provider/model` ids.

### Model registry

Selectable models — pricing, context window, capability flags — live in
`src/domain/llm/models.ts`, and are hand-maintained: those numbers exist only in
each provider's documentation. Ids can be checked against what the configured
channels actually serve:

```bash
pnpm check-models             # ids the channels serve but the registry lacks, and vice versa
pnpm check-models --since=90d # ...only models released in the last 90 days
pnpm check-models --strict    # exit 1 on drift, or if a channel failed to answer
```

`--strict` fails on a registered model no channel serves, and on a channel that
did not answer — a check that could not run must not read as all clear. It does
*not* fail on the long list of served-but-unregistered ids: that is the
provider's whole catalog minus this app's curated selection (embeddings,
realtime, internal codenames), so gating on it would be an exit code that can
never be green. Add `--since` to make newly released models count too, which is
the form worth putting in CI.

Registry ids follow the router convention (`anthropic/claude-opus-4.8`), which is
also what stored project versions hold. When a provider's own API spells the same
model differently — Anthropic serves `claude-opus-4-8` and 404s on the dotted
form — set `wireId` on that entry; it is what gets sent once a provider-direct
channel strips the prefix.

A model that is missing from the registry still runs, but its usage is priced at
$0 — so the gap is invisible in the cost dashboard it corrupts. Each miss logs
`[cost] unknown model id` once and increments
`agent_studio_unknown_model_calls_total` on `/api/metrics`; alert on a non-zero
rate rather than waiting to notice the cost.

## Development

```bash
pnpm typecheck      # tsc --noEmit (strict)
pnpm test           # Vitest unit tests
pnpm build          # production build
```

## Access Control & Runtime Settings

- Login is Google OAuth, restricted to `ALLOWED_EMAIL_DOMAINS` (comma-separated;
  unset allows any domain).
- `ADMIN_EMAILS` (comma-separated) restricts mutations of the shared skill/MCP/agent
  registries and access to the `/settings` page; unset allows any signed-in user.
- The admin `/settings` page stores runtime overrides for selected env vars
  (admin/allowed-domain lists, LLM channels, skills repo,
  A2A key, public base URL) in DynamoDB — a stored override wins over the env value.
- The header theme control cycles through system, light, and dark appearances. The
  selection is stored in the browser; system mode follows operating-system changes.

## Daily cost limits

Each project may set two independent thresholds under **Project Settings → Daily cost
limits**, measured per UTC day across every model it runs:

- `alertThresholdUsd` — post a notification once, keep running.
- `blockThresholdUsd` — refuse every run for the rest of the day. All six execution entry
  points (predict, `chat/completions`, agent SSE, chat, Slack, A2A) and image generation
  answer `429` with `Retry-After` set to the seconds until 00:00 UTC.

Notifications go to `alertSlackChannel` using the project's own Slack bot, once per
threshold per day (a conditional write on the usage row, so two instances crossing together
still post once). With no channel or no bot configured the thresholds still block — a
missing notification path must not disable the guard.

**What this bounds, and what it does not.** An agent run buffers its usage and flushes once
at the end, so the check that admits a run cannot see what runs already in flight have
spent: runs starting together all pass it, and the block becomes true on the check that
follows the flush. It is a daily backstop against a runaway loop or a heavy caller, not a
hard ceiling and not a rate limit. Every read failure fails open — the guard must not become
a second way for a storage blip to stop the platform.

## Webhook triggers

An outside system can start a run by posting to a trigger's URL with its secret. Configure
them under **Project Settings → Webhook triggers**; each has a delivery URL, an `asw_…`
secret sent as `X-Trigger-Secret`, and a history of recent deliveries. The trigger id follows
the same slug rule as a project name and is normalised for you. The secret is stored
encrypted, so — like a project API token — you can reveal it again or regenerate it from the
same panel rather than losing it after creation.

```bash
curl -X POST https://<host>/api/triggers/my-project/nightly \
  -H "X-Trigger-Secret: $TRIGGER_SECRET" \
  -H "Idempotency-Key: $EVENT_ID" \
  -d '{"event":"nightly-report"}'
```

- Always runs the project's **published** version — a draft is configuration in progress.
- Answers `202` immediately and runs in the background; the outcome lands on the delivery's
  history row, because a run can take ten minutes and no sender waits that long.
- `Idempotency-Key` makes a redelivery a no-op for 24 hours.
- Overlapping runs are off by default: a delivery arriving while one is still going is
  recorded as `skipped` rather than piling runs up.
- Every refusal — disabled, duplicate, busy, no published version — is a row with a status,
  so "it never fired" is distinguishable from "it fired and failed" without reading logs.
- The payload becomes the user message (agent projects) or template variables (prompt
  projects), configurable per trigger.

Like the Slack path, background work does not survive an instance dying mid-delivery; that
row stays `running`. See `docs/MILESTONES.md` (schedule-trigger) for the durable worker that
would close it.

## Concurrency limits

One caller may have `MAX_CONCURRENT_RUNS_PER_ACTOR` runs in flight at once (default 10);
inbound A2A has its own `MAX_CONCURRENT_RUNS_A2A` (default 50), because the inbound key is
shared so one identity stands for every machine caller. `0` turns a limit off. Over the
limit, the run is refused with `429` and a short `Retry-After` — and refused before it
starts, so it records no usage and no trace.

This is the fast-acting half of the pair: per-run bounds (10 minutes, 50 turns, tool-result
caps) bound one run and the chat run lease bounds one chat, but neither stops the same person
opening twenty chats or calling `/predict` in a loop, and the daily cost guard only reacts
once the money is spent.

Slots live in DynamoDB, not in process memory, so the limit does not multiply by the number
of instances. Each is a leased row reclaimed automatically, so an instance that dies
mid-run does not hold one forever. Unlike the cost guard this one **fails closed**: opening
it when the store is unreachable would add load at exactly the wrong moment, and every run
needs that same table anyway.

## Project API

Each project's **API Reference** tab documents how to call it from outside the
console — the execution endpoints (`predict`, `chat/completions`, `agent`), plus the
A2A and Slack endpoints when those are configured — with the project's own name and
published version filled in. Every entry carries a copyable curl example, and the
OpenAI-compatible endpoint adds Python and Node.js SDK samples; credentials appear
only as `$PROJECT_API_TOKEN`-style placeholders.

Generate the token under Project Settings → API token: it is scoped to that project and
sent as `Authorization: Bearer <token>` in place of the session cookie. The token is
stored AES-256-GCM encrypted rather than hashed, so the project owner can reveal and copy
it again later — the trade is that stored ciphertext is usable to anyone who obtains both
the table and `AES_ENCRYPTION_KEY`, where a hash would not be. Tokens issued before this
change hold only a hash: they keep working but cannot be revealed, so regenerate one to
read it back. See [docs/API.md](docs/API.md) for the full contract.

## Images

**Input.** A message body may carry OpenAI content parts, so a run can be given images to
look at: `chat/completions` accepts them inline as `data:image/…;base64,…` (or an `https://`
url the provider fetches), a Slack mention or DM's image attachments are downloaded and sent
the same way, and the console's chat composer takes up to 4 images (5MB each,
`png`/`jpeg`/`gif`/`webp`) per turn — attach-only turns included. The version's model must
have the `imageInput` capability, otherwise the request is rejected rather than quietly
losing the picture.

Every project type's **RUN** panel takes attachments: an `agent`/`llm` run sends them for the
model to look at, an `image` run edits them.

**Generation and editing.** `image` projects generate images directly — attach source images
to the run (console **RUN** panel, or `images` on `predict`) and the prompt edits them
instead. Agent runs can draw with the builtin `GenerateImage` tool and change an existing
image with `EditImage` — both enabled by a version's `imageGeneration` parameter. `EditImage`
addresses an image by a per-run handle (`img_1`, `img_2`, …) covering both what the user sent
and what the run drew, so "now make it night" works on either. Those handles also travel
through a subagent transfer as `image_ids`, so an agent can hand a picture to a dedicated
image project and get it *edited* instead of redrawn. Generated images are uploaded to a
public-read S3 bucket when `S3_BUCKET_NAME` is set; unset disables persistence.

## PII Filtering

Versions can opt in via the `piiFiltering` parameter. When enabled, emails and
phone numbers in prompts and variables are replaced with format-preserving
placeholder tokens before any LLM call, and the original values are restored in
the response (streaming included) — the model never sees the real values.
Detection is regex-based (emails and phone numbers only), so treat it as
best-effort masking, not a guarantee.

The boundary is the **LLM channel and the engine's own context**, not every
outbound call. When the model invokes an MCP tool, that tool receives the real
argument values — a tool asked to email `a@b.com` needs the address, not a token
— so a connected MCP server still sees the PII it is passed. (A subagent transfer
is the opposite: the child agent receives the masked message.) Review MCP server
registrations on their own terms; `piiFiltering` does not cover them.

## Skills Repository

Skills can sync from a GitHub repository (`SKILLS_REPO=owner/repo`,
`GITHUB_TOKEN` with contents read access, optional `SKILLS_REPO_BRANCH`).
The repo layout is `skills/<name>/SKILL.md` with optional YAML frontmatter
(`description:`); the parent directory name is the skill slug. `POST
/api/skills/sync` (or the Sync button on /skills) upserts every SKILL.md —
the repo is the source of truth for synced skills, while locally-created
skills with other names are untouched.

Supported text files under a skill's directory (e.g. `references/*.md`,
templates) are collected as attachments and loaded on demand via the `Skill`
tool's `file_path`, subject to per-file / per-skill size and count caps;
symlinks, unsupported types, and oversized files are skipped and reported. A
call without `file_path` returns the SKILL.md body as before.

## Slack Integration

Each agent project can have its own dedicated Slack app.
Project Settings → Slack bot generates a project-specific manifest (events URL
`/api/slack/events/<project>`), and stores the pasted bot token + signing secret
AES-encrypted with masked reads. Events on that URL are verified with that
project's own secret and always run that project — no selector needed.

- Subscribe to `app_mention` and `message.im`; the generated manifest requests
  every bot scope the integration needs (mentions, DMs, files, reactions, user
  profiles, …). It also enables Slack's MCP server and lists this deployment's
  `/api/mcps/oauth/callback` as a redirect URL, so the same app can be registered
  here as an OAuth MCP server.
- Replies stream into one message via `chat.update`; a mention inside a thread carries the
  thread (its 50 most recent turns) as multi-turn context.
- Image attachments are downloaded with the bot token and analyzed — up to 4 images per run,
  5MB each, `png`/`jpeg`/`gif`/`webp`. The mention's own images come first; whatever budget is
  left goes to the newest images in the 10 most recent turns of the thread, so "make the
  picture I sent blue" still has the picture without re-fetching a long thread's whole
  history. Only the humans' pictures count — the bot's own uploads are skipped. Anything
  skipped is reported in the reply.
- Events are verified (signing secret, 5-minute replay window), deduplicated by
  `event_id` (conditional put, 24h TTL), acked within 3 seconds, and processed in
  the background. `after()` requires a persistent process; an abrupt process loss can
  still interrupt work after the event has been claimed.

## Cost attribution

Every run records **who caused it**. Projects are a shared catalog — any signed-in user may
run any project — so the project name alone never answered "who spent this".

An actor is a kind plus an id: `user` (email), `project-token` (the *owner's* email, because
a token authenticates as them — the kind is what keeps a machine's spend apart from that
person's own runs), `slack` (Slack user id), `a2a` (a constant; the key is shared, so there
is nobody to name). It lands in two places: on the run's trace, and on a per-caller daily
usage row read through `GET /api/projects/{name}/usage/actors` (owner/admin only — project
totals are open, a breakdown by caller names individuals).

The actor belongs to the run, not the turn, so the model calls a subagent transfer makes on
another project are attributed to whoever started the run rather than to the project it
transferred into.

## Tracing

Agent executions always persist model/tool/subagent spans. Non-agent and image predict
executions are sampled with `TRACE_SAMPLE_RATE` (`0`–`1`, default `0.1`). Traces are visible
on each project's **Traces** tab to the project owner only (they hold other users' runtime
inputs/outputs). Raw prompts and tool results are not stored; spans keep
only bounded metadata such as character counts, tokens, cost, duration, and subagent trace ids.

Traces, usage rows, chats, and inbound A2A tasks expire via DynamoDB TTL (`expiresAt`) so the
table stays bounded — default retention is 30 / 400 / 180 / 1 days, overridable with
`TRACE_RETENTION_DAYS`, `USAGE_RETENTION_DAYS`, `CHAT_RETENTION_DAYS`, and
`A2A_TASK_RETENTION_DAYS`. Enable TTL on the `expiresAt` attribute of the production table.

## Logs and metrics

Every run carries a correlation id, stamped on each of its log lines as
`[scope run=… trace=…]`. Work started outside a request uses the id you can already see: a
webhook delivery's lines carry the delivery id from its history row, a Slack event's carry
the Slack event id. It is independent of the trace id on purpose: traces are sampled on
the non-agent paths, so a trace id would leave most prompt and image runs with nothing to
correlate on. Where a trace does exist, both ids appear.

`/api/metrics` reports in-flight runs (the autoscaling signal — runs are I/O bound, so a
saturated instance still reads as idle CPU), `agent_studio_runs_failed_total` and an
`agent_studio_run_duration_seconds` histogram (the alerting signals), the unknown-model
counters, and whether the instance is draining. No metric is labelled by project, user or
model: unbounded label values turn one metric into a time series per value.

## A2A (Agent2Agent)

Both directions of the [A2A protocol](https://a2a-protocol.org) are supported.

**Inbound — expose a project as an A2A agent.** Set `A2A_API_KEY` (unset
disables the endpoints). Every project with a published version then serves:

- `GET /api/a2a/<project>/.well-known/agent-card.json` — public Agent Card
- `POST /api/a2a/<project>` — JSON-RPC (`message/send`, `message/stream`,
  `tasks/get`, `tasks/cancel`), authenticated with an `X-A2A-Key` header
  matching `A2A_API_KEY`

Agent Card URLs are built from `PUBLIC_BASE_URL`. Task state (`message/send` →
`tasks/get`/`tasks/cancel`) is persisted per-project in DynamoDB, so it survives
redeploys and is shared across instances; a terminal-state-guarding conditional
write keeps a concurrent complete/cancel from regressing a finished task. Rows
expire via TTL (`A2A_TASK_RETENTION_DAYS`, default 1 day).

**Outbound — call external A2A agents.** Register an agent on /agents with
protocol `A2A` and its Agent Card URL; custom headers are sent on card
resolution and RPC calls (stored AES-encrypted). The agent is then usable as a
`type: "remote"` subagent and via the test-message endpoint, same as
OpenAI-compatible agents. Note: outbound URLs are operator-provided; they are
SSRF-guarded (private, loopback, link-local and cloud-metadata addresses are
rejected at registration and dispatch), but any public URL is allowed — register
only trusted agents.

## Deployment

The build artifact is a container image.

```bash
docker build -t agent-studio .        # multi-stage, Next standalone output
docker compose up --build             # local container + DynamoDB Local
```

- The `Release` workflow builds the image and pushes it to ECR on version tags
  (`v*`), authenticating via GitHub OIDC.
- `/api/ready` is the LB/orchestrator health check: it probes DynamoDB and the LLM
  channel and returns 503 when a downstream is unreachable or the instance is draining.
  `/api/health` is a static liveness probe (unauthenticated, dependency-free) for restart
  decisions; both are unauthenticated.
- node runs as PID 1 (exec-form CMD) so SIGTERM drains in-flight SSE streams on
  rolling deploys; on SIGTERM the instance flips `/api/ready` to unready first so the LB
  stops routing new traffic. Pair with a generous container `stopTimeout` (e.g. 120s).
- Every run (predict, chat, agent, Slack, A2A, image) is bounded by a wall-clock
  deadline — `MAX_RUN_DURATION_MS`, default `600000` (10 minutes) — so a hung provider
  or tool call cannot run, or bill, unbounded.
- A bound MCP server's tool list is cached in process memory for
  `MCP_DISCOVERY_CACHE_TTL_MS` (default `60000`), which also lets a turn that calls no tool
  skip the MCP handshake entirely. Editing the registry entry invalidates it on the instance
  that served the edit; the entry's lifetime bounds the others.
  A server that sends its own `ttlMs` on `tools/list` sets that lifetime instead, capped by
  `MCP_MAX_SERVER_TTL_MS` (default `300000`) — the cap is what keeps a server from deciding
  how long a registry edit stays unseen across the fleet, so raise it on single-instance
  deployments and keep it near your tolerable staleness on multi-instance ones. Set it to `0`
  to ignore server hints entirely. `MCP_DISCOVERY_CACHE_TTL_MS=0` disables caching outright
  and no server hint overrides it.
- AWS credentials come from the task/instance role — never bake keys into the image.
