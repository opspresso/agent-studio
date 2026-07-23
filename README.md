# ✨ Agent Studio

LLM platform for prompt, agent, and cost management — a production-level single Next.js full-stack application.

Covered domains: **projects/versions, LLM engine, agents (subagents + external registry),
skills, MCP tools, chats, cost/usage dashboard**.

## Stack

- Node.js 22, pnpm 11
- Next.js 16 (App Router), React 19, TypeScript strict
- Tailwind CSS v4
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
# AES_ENCRYPTION_KEY (32-byte base64: `openssl rand -base64 32`)

# 3. Local DynamoDB
docker run -d -p 8000:8000 amazon/dynamodb-local
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

# End-to-end integration check (repositories + engine against local DynamoDB)
pnpm tsx --env-file=.env.local scripts/integration-check.ts

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
  (admin/allowed-domain lists, LLM channels, Slack workspace bot, skills repo,
  A2A key, public base URL) in DynamoDB — a stored override wins over the env value.

## Image Generation

`image` projects generate images directly, and agent runs can generate them via the
builtin `GenerateImage` tool. Generated images are uploaded to a public-read S3
bucket when `S3_BUCKET_NAME` is set; unset disables persistence.

## PII Filtering

Versions can opt in via the `piiFiltering` parameter. When enabled, emails and
phone numbers in prompts and variables are replaced with format-preserving
placeholder tokens before any LLM call, and the original values are restored in
the response (streaming included) — the model never sees the real values.
Detection is regex-based (emails and phone numbers only), so treat it as
best-effort masking, not a guarantee.

## Skills Repository

Skills can sync from a GitHub repository (`SKILLS_REPO=owner/repo`,
`GITHUB_TOKEN` with contents read access, optional `SKILLS_REPO_BRANCH`).
The repo layout is `skills/<name>/SKILL.md` with optional YAML frontmatter
(`description:`); the parent directory name is the skill slug. `POST
/api/skills/sync` (or the Sync button on /skills) upserts every SKILL.md —
the repo is the source of truth for synced skills, while locally-created
skills with other names are untouched.

## Slack Integration

Two modes that can coexist:

**Per-project bots** — each agent project can have its own dedicated Slack app.
Project Settings → Slack bot generates a project-specific manifest (events URL
`/api/slack/events/<project>`), and stores the pasted bot token + signing secret
AES-encrypted with masked reads. Events on that URL are verified with that
project's own secret and always run that project — no selector needed.

**Workspace default bot** — one bot per workspace, configured by env (`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`,
optional `SLACK_DEFAULT_PROJECT`). Point the Slack app's Events API request URL at
`https://<host>/api/slack/events` and subscribe to `app_mention` and `message.im`
(scopes: `app_mentions:read`, `im:history`, `chat:write`).

- Mention the bot with `project:<name> <message>` to pick an agent project, or rely
  on `SLACK_DEFAULT_PROJECT`.
- Replies stream into one message via `chat.update`; thread replies carry the full
  thread as multi-turn context.
- Events are verified (signing secret, 5-minute replay window), deduplicated by
  `event_id` (conditional put, 24h TTL), acked within 3 seconds, and processed in
  the background. `after()` requires a persistent process; an abrupt process loss can
  still interrupt work after the event has been claimed.

## Tracing

Agent executions always persist model/tool/subagent spans. Non-agent and image predict
executions are sampled with `TRACE_SAMPLE_RATE` (`0`–`1`, default `0.1`). Traces are visible
on each project's **Traces** tab. Raw prompts and tool results are not stored; spans keep
only bounded metadata such as character counts, tokens, cost, duration, and subagent trace ids.

## A2A (Agent2Agent)

Both directions of the [A2A protocol](https://a2a-protocol.org) are supported.

**Inbound — expose a project as an A2A agent.** Set `A2A_API_KEY` (unset
disables the endpoints). Every project with a published version then serves:

- `GET /api/a2a/<project>/.well-known/agent-card.json` — public Agent Card
- `POST /api/a2a/<project>` — JSON-RPC (`message/send`, `message/stream`,
  `tasks/get`, `tasks/cancel`), authenticated with an `X-A2A-Key` header
  matching `A2A_API_KEY`

Agent Card URLs are built from `PUBLIC_BASE_URL`. Task state is in-memory and
resets on redeploy.

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
- The `Deploy` workflow (manual `workflow_dispatch`) runs typecheck + tests, builds
  and pushes the image to ECR, then forces a new ECS service deployment and waits
  for it to stabilize.
- `/api/health` is the LB/orchestrator health check (unauthenticated, dependency-free).
- node runs as PID 1 (exec-form CMD) so SIGTERM drains in-flight SSE streams on
  rolling deploys; pair with a generous container `stopTimeout` (e.g. 120s).
- AWS credentials come from the task/instance role — never bake keys into the image.
