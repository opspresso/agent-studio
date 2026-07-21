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
- AWS Amplify hosting (`amplify.yml`)

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the layer rules, single-table key map,
domain semantics, and API surface.

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

## Deployment

AWS Amplify picks up `amplify.yml` (pnpm via corepack, Next.js SSR build). Configure the
environment variables from `.env.example` in the Amplify console. DynamoDB access uses the
Amplify service role; the table and GSIs (`GSI1`, `GSI2`) must exist (see
`scripts/init-local-table.ts` for the schema).
