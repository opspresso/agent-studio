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
cp .env.example .env
# Fill in GOOGLE_CLIENT_ID/SECRET, BETTER_AUTH_SECRET, LLM_BASE_URL, LLM_API_KEY,
# AES_ENCRYPTION_KEY (32-byte base64: `openssl rand -base64 32`)

# 3. Local DynamoDB
docker run -d -p 8000:8000 amazon/dynamodb-local
pnpm init-local-table

# 4. Run
pnpm dev            # http://localhost:3000
```

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
