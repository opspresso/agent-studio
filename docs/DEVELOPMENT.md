# Development

Setting up, running, and verifying AgentDure locally.

Related: [CONFIGURATION.md](CONFIGURATION.md) for every variable,
[ARCHITECTURE.md](ARCHITECTURE.md) for the layer rules the tests enforce, and
[../AGENTS.md](../AGENTS.md) for the conventions a change has to respect.

## Prerequisites

- **Node.js 24+** (`engines: >=24`)
- **pnpm 11.10.0**, pinned via `packageManager` — use corepack rather than a global install
- **Docker**, for DynamoDB Local

```bash
corepack enable && corepack prepare pnpm@11.10.0 --activate
pnpm install
```

## Environment

```bash
cp .env.example .env.local
```

The minimum for a real run is `LLM_BASE_URL`, `LLM_API_KEY` and `AES_ENCRYPTION_KEY`
(32-byte base64 — `openssl rand -base64 32`). `src/instrumentation.ts` validates these at
boot, so a missing one fails at startup rather than on the first request. Google OAuth
credentials are only needed for real login; the dev-session script below bypasses OAuth.

See [CONFIGURATION.md](CONFIGURATION.md) for the full list.

## Local DynamoDB

```bash
docker compose up -d dynamodb        # dev instance on :8083
pnpm init-local-table                # create the table + GSIs
pnpm dev                             # http://localhost:3000
```

> **Both DynamoDB Local containers are shared with every other project on this machine.**
> `compose.yaml` pins the compose project name to `localdev`, so `docker compose up -d
> dynamodb` from another repository finds these already up and leaves them alone.
>
> **Table names, not ports, keep the projects apart.** Never widen a cleanup past
> `DYNAMODB_TABLE_NAME`, and never run `docker compose down -v` (the volume belongs to every
> project) or `--remove-orphans` (it would take out containers another repository started).

DynamoDB Local namespaces tables by access key and region *unless started with `-sharedDb`* —
which both `compose.yaml` services are, so a region or credential mismatch between the app and
`init-local-table` does not split them into invisible parallel table sets.

`init-local-table` refuses to run against a non-local endpoint, so alpha/prod can never be
touched by it.

## Working without real credentials

```bash
# Mock OpenAI-compatible LLM server, then set LLM_BASE_URL=http://127.0.0.1:8002/v1
pnpm tsx scripts/mock-llm.ts

# Create a dev user + session and print a signed session cookie
pnpm tsx --env-file=.env.local scripts/dev-session.ts

# Seed sample skills (existing skills of the same name are left untouched)
pnpm tsx --env-file=.env.local scripts/seed-skills.ts
```

## Commands

```bash
pnpm dev              # next dev
pnpm build            # production build (standalone) — validates route handlers + instrumentation
pnpm typecheck        # tsc --noEmit, strict + noUncheckedIndexedAccess
pnpm test             # vitest run
pnpm test:watch       # vitest watch
pnpm test:integration # repository + engine check against local DynamoDB
pnpm check-models     # diff the model registry against what the channels serve
```

```bash
# a single test file, or by test name
pnpm exec vitest run tests/engine.test.ts
pnpm exec vitest run -t "streamWithFallback"
```

**There is no lint step** — no ESLint config exists. `typecheck` + `test` are the checks.
`build` is a third: it is what catches an invalid route handler signature or a broken
instrumentation import.

## Scripts

| Script | Purpose |
|---|---|
| `scripts/init-local-table.ts` | Create the single table with `GSI1`/`GSI2` on DynamoDB Local. Refuses non-local endpoints. |
| `scripts/dev-session.ts` | Write a dev user + session straight to DynamoDB and print a signed session cookie — exercises authenticated routes without the OAuth round-trip. |
| `scripts/mock-llm.ts` | Standalone mock OpenAI-compatible server on `127.0.0.1:8002` (`MOCK_LLM_PORT`). Streams and non-streams; requests a `Skill` tool call once when tools are offered *and* the messages mention `skill named "<slug>"`. `MOCK_LLM_CHUNKS` and `MOCK_LLM_DELAY_MS` pad and slow the answer into a long streaming reply — the only way to see what a chat window does while one arrives; the defaults keep the one-line answer the integration check expects. |
| `scripts/seed-skills.ts` | Seed sample skills, idempotently. |
| `scripts/integration-check.ts` | End-to-end repository round-trips + the engine (single-shot and agent loop). |
| `scripts/check-models.ts` | Diff `src/domain/llm/models.ts` against the ids the configured channels serve. |

### `check-models`

The registry is hand-maintained because pricing, context windows and capability flags exist
only in each provider's documentation. Model **ids** are the part that goes stale silently —
a provider ships a model, nobody notices, and the first symptom is a run booked at $0.

```bash
pnpm check-models              # report both directions; always exits 0
pnpm check-models --since=90d  # only models released in the last 90 days
pnpm check-models --strict     # exit 1 on drift, or if a channel failed to answer
```

`--strict` fails on a registered model that no channel serves, and on a channel that did not
answer — a check that could not run must not read as all clear. It deliberately does **not**
fail on served-but-unregistered ids: that list is the provider's whole catalog minus this
app's curated selection (embeddings, realtime, internal codenames), so gating on it would be
an exit code that can never be green. Adding `--since` makes newly released models count,
which is the form worth putting in CI.

It reads a `sigv4` channel through the same signer the runtime dispatches with, so a Bedrock
channel needs AWS credentials in the environment (`AWS_PROFILE=opspresso` locally) — without
them it reports as a failed channel. A router channel makes the unregistered list long by
nature: OpenRouter serves hundreds of ids, so use `--since` when reading that half.

## Integration check

```bash
docker compose up -d dynamodb-test
pnpm init-local-table:test
pnpm test:integration
```

It runs against a **separate** instance on `:8084` and the `agentdure-test` table, because
it writes fixtures and cascade-deletes them. Do not pass `--env-file=.env.local` — the script
refuses to run against `:8083`, and the table name is the second layer under that guard. The
`dynamodb-test` container is `-inMemory`, so it is wiped on every start and
`init-local-table:test` has to recreate the table.

It lives outside vitest because it needs real network and real storage, which every unit test
is forbidden from touching.

## CI

`.github/workflows/ci.yml` runs on every push to `main` and every pull request:

```
typecheck → test → init-local-table:test + test:integration → build
```

A `dynamodb-local` service container is exposed on host port `8084` — the port the integration
check connects to. `services:` cannot pass command arguments, so the compose flags are absent
there, and neither is needed: a fresh container per job is already empty, and one job holds a
single credential and region.

`.github/workflows/check-models.yml` runs `pnpm check-models --strict --since=30d` weekly (and
on demand) rather than per pull request: it needs live provider APIs and the `LLM_BASE_URL` /
`LLM_API_KEY` repository secrets, so a provider outage or a fork without secrets must not fail
PRs.

## Tests

Unit tests live under `tests/`. Conventions:

- **Mock at boundaries.** `fetch` via `vi.stubGlobal`, the DynamoDB doc client via
  `vi.mock("@/infrastructure/db/client")`. Do not mock application code to test application
  code.
- **Deterministic.** No real `Date.now`, timers, randomness or network. The engine is
  testable this way because everything it needs is injected — see `tests/fakeChannel.ts`.
- Repository behaviour against real storage belongs in `scripts/integration-check.ts`, not in
  a vitest file.

### `tests/architecture.test.ts`

This is the structural gate, and it fails loudly rather than warning. It enforces:

1. **Thirteen layer rules**, each with an **empty allowlist** — `domain` imports nothing else
   and no framework/AWS/auth library; `application` imports no `infrastructure` or `app`,
   nothing from `lib` beyond its pure leaves, and nothing outside the domain and the standard
   library; `infrastructure` imports no `application` or `app`; `shared` imports nothing from
   `@/` but its own siblings, and no package outside the standard library; adapters and use
   cases do not import the composition root; `app` imports no `infrastructure` outside its
   wiring sites; `lib` imports no `infrastructure` outside its wiring modules and no
   `application` outside the composition root; `components` imports no `infrastructure` or
   `application`.
2. **Single-owner invariants** — a named decision plus the file that owns it. A second copy
   fails, *and so does the owner losing the definition*. The list is in
   [../AGENTS.md](../AGENTS.md#single-owner-invariants).
3. **Bounded caller lists**, for the three decisions that have a fixed set of call sites
   rather than an owner: which surfaces start an image run (`IMAGE_RUN_ENTRY_POINTS`), which
   start an agent run by calling `executeAgent` directly (`AGENT_RUN_ENTRY_POINTS`), and where
   a version's tools are resolved (`TOOL_RESOLUTION_SITES`, each of which must also name
   `discoveryQueries` — resolving without them silently disables capability discovery). A
   fourth entry is added to any of them on purpose, which is what the list buys.
4. **Composition** — a repository the routes no longer compose reaches no route handler, `app`
   composes only at its wiring sites, the application slice graph has no cycles, and the
   composition root decides every optional `ExecutionDeps` field by name.
5. **Configuration reads** — `process.env` is not reached from domain, shared, the adapters or
   the use cases; config arrives injected. One file is excepted by name, and the exception is
   itself checked for still being true.
6. **The client bundle** — what a `"use client"` entry can reach transitively. The entry count
   is asserted exactly rather than as merely non-empty, because a scan that has gone blind
   reads just like a clean pass.
7. **React event handling**, two rules. No `currentTarget` read inside a `setState` updater —
   React nulls `SyntheticEvent.currentTarget` once the handler returns, so a deferred read
   throws whenever React batches. And no block-rooted Mantine component (`Badge`, `Group`,
   `Stack`, …) inside a `<Text>` or `<Title>` — those render a `<p>`/`<h*>`, which a browser
   *closes* where a `<div>` opens inside it, so the server's HTML and React's tree disagree
   and hydration fails. `component="span"` on the inner one, or `component="div"` on the
   outer, is the fix and is what the rule looks for.
8. **Edge runtime compatibility** — imports that would pull `node:crypto` or the AWS SDK into
   the edge bundle.
9. **Create modals reset what they declare** — every field a create modal holds in `useState`
   is cleared before `onCreated()`, so a reopened modal never shows the previous entry's
   values.
10. **The scanner's own tests**, so a rule that silently stopped matching is caught.

> When one of these fails, **fix the import — do not widen the rule.** The allowlists are
> empty on purpose: adding a violation is meant to be a visible decision, not a quiet one.

## Adding to the codebase

| Adding… | Goes in | Wire it at |
|---|---|---|
| An entity or repository port | `src/domain/<slice>/` | — (pure TS, no imports from `@/` beyond `domain`) |
| A use case | `src/application/<slice>/` | It receives deps; it must not import `container.ts` |
| An adapter (DB, HTTP, cloud) | `src/infrastructure/<slice>/` | `src/lib/container.ts` |
| A route handler | `src/app/api/…/route.ts` | Pull repositories and `executionDeps` from a wiring site, never `infrastructure/` directly |
| Shared UI | `src/app/_components/` | — |
| A dependency-free helper | `src/shared/` | — |

Checklist for a new slice:

- [ ] Domain types carry no framework or AWS imports.
- [ ] Key strings come from `src/infrastructure/db/keys.ts`, never hand-written.
- [ ] List queries paginate through `queryAll()` — a single Query page caps at 1MB and an
      unpaginated list silently truncates.
- [ ] New rows that grow without bound carry an `expiresAt` from `src/infrastructure/db/ttl.ts`.
- [ ] A new execution entry point calls the facade rather than re-encoding the projectType
      dispatch, and opens the run bracket — `streamProjectRun` for a consumer that takes a run
      as chunks, image included; `executeProjectStream`/`executeProject` for one that answers
      with a completion, which refuse an image project.
- [ ] A decision that now exists in two places gets a single owner and an entry in
      `SINGLE_OWNERS`.
- [ ] `pnpm typecheck && pnpm test && pnpm build` pass.

## Documentation

| File | Role |
|---|---|
| [../README.md](../README.md) | What it is, how to run it, what it can do |
| [../AGENTS.md](../AGENTS.md) | Working rules for coding agents (`CLAUDE.md` is a symlink to it) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Design and rationale |
| [API.md](API.md) | HTTP contract |
| [CONFIGURATION.md](CONFIGURATION.md) | Every environment variable and fixed limit |
| [OPERATIONS.md](OPERATIONS.md) | Deploy, probe, scale, retain |
| [SECURITY.md](SECURITY.md) | Auth, secrets, SSRF, PII |
| [MILESTONES.md](MILESTONES.md) | Remaining work (Korean) |

Two subsystems carry their own local `AGENTS.md`, and they are the authority for the
invariants inside them — read them before editing those files:

- `src/application/llm/AGENTS.md` — the tool loop, system-prompt assembly, author contract,
  fallback semantics, PII boundaries, usage recording.
- `src/application/chat/AGENTS.md` — chat persistence, replay, and the history budgets.

Documentation records the **current** state, not change history: completed milestones are
deleted from `MILESTONES.md`, and git log plus the per-tag GitHub Release is the record.
