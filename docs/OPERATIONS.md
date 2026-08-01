# Operations

Deploying, probing, scaling, and keeping the table bounded.

Related: [CONFIGURATION.md](CONFIGURATION.md) for every variable named here,
[SECURITY.md](SECURITY.md) for credential handling, [DEVELOPMENT.md](DEVELOPMENT.md) for the
local loop.

## Build artifact

The deployable is a container image. The build is multi-stage and ships Next.js
**standalone** output — dependencies are traced into the artifact, so the runtime stage
carries no `node_modules` install.

```bash
docker build -t agent-studio .
docker compose up --build          # local container + DynamoDB Local
```

The runtime stage runs as a non-root `app` user and declares a `HEALTHCHECK` against
`/api/health`.

**node runs as PID 1** (exec-form `CMD`), so `SIGTERM` reaches it directly rather than being
swallowed by a shell. That is what lets in-flight SSE streams drain during a rolling deploy.

AWS credentials come from the task/instance role. Never bake keys into the image.

## Release pipeline

`.github/workflows/release.yml`, triggered by a `v*` tag (or manual dispatch):

1. **verify** — `pnpm typecheck` + `pnpm test`.
2. **github-release** — creates the GitHub Release, with notes generated from
   `git log` between the previous tag and this one (`chore: release` commits filtered out).
   This is the project's change history: completed milestones are *deleted* from
   [MILESTONES.md](MILESTONES.md) rather than archived, so git log and the Releases page are
   the record.
3. **release** — assumes an AWS role via GitHub OIDC (no long-lived keys), logs in to ECR,
   builds `linux/amd64` and pushes `:{tag}` and `:latest`.
4. **GitOps trigger** — mints a short-lived GitHub App installation token scoped to the
   `argocd-env-demo` repository alone and sends a `repository_dispatch`, which bumps the image
   tag for the `alpha` phase. `GITHUB_TOKEN` cannot be used here: it is scoped to the
   repository running the workflow.

Two non-obvious build settings:

- **amd64 only.** The sole deployment target runs amd64 nodes, and free arm64 hosted runners
  are not available on private repositories.
- **`provenance: false`, `sbom: false`.** BuildKit adds a provenance attestation by default,
  and an attestation rides as an extra manifest inside an image index — so even a
  single-platform build pushed an index plus two untagged children. Every release cost three
  ECR entries instead of one, and the untagged ones are what a tag points at, which makes the
  obvious "expire untagged images" lifecycle rule delete the image a released tag needs.

## Health probes

| Endpoint | Kind | Behaviour |
|---|---|---|
| `GET /api/health` | liveness | Static `200`. Dependency-free, unauthenticated. Answers "is the process serving". |
| `GET /api/ready` | readiness | Probes DynamoDB and the LLM channel (short timeout, details not surfaced). `503` when a downstream is unreachable **or** the instance is draining. |

Point restart checks at `/api/health` and the load balancer at `/api/ready`.

### Readiness on a horizontally-scaled deployment

The LLM check is the wrong thing to gate on when many instances share one provider: a single
provider blip marks the **whole fleet** unready at once — including the console, chats and
dashboards, none of which need the provider.

On such a deployment, point readiness at `/api/health` too and let the platform's own
deregistration handle draining. A `preStop` pause covers the endpoint-propagation window.

### Draining

On `SIGTERM`/`SIGINT` the instance flips to draining (`src/shared/lifecycle.ts`):
`/api/ready` immediately answers `503` so the load balancer stops routing new traffic, while
the standalone server finishes in-flight requests. The module never calls `process.exit` —
the runtime owns that.

Pair this with a generous container `stopTimeout` (e.g. 120s). A run can last up to
`MAX_RUN_DURATION_MS` (default 10 minutes), so a short grace period will cut streams that
would have completed.

## Metrics

`GET /api/metrics` is a Prometheus scrape endpoint — unauthenticated and dependency-free like
`/api/health`, because it is scraped in-cluster on the pod address.

| Metric | Type | Use |
|---|---|---|
| `agent_studio_active_runs` | gauge | **The autoscaling signal.** |
| `agent_studio_runs_started_total` | counter | Throughput. |
| `agent_studio_runs_finished_total` | counter | Throughput. |
| `agent_studio_runs_failed_total` | counter | **Alerting signal.** Cancellations are not failures. |
| `agent_studio_run_duration_seconds` | histogram | **Alerting signal.** Buckets `0.5 … 600`. |
| `agent_studio_unknown_model_calls_total` | counter | Correctness signal — see below. |
| `agent_studio_unknown_models` | gauge | Distinct unregistered model ids seen. |
| `agent_studio_draining` | gauge | `1` once shutdown began. |

**Autoscale on `agent_studio_active_runs`, not CPU.** Runs are I/O bound — an instance
saturated with them still reads as idle CPU.

**Alert on failures and duration, not the gauge.** The gauge says how busy an instance is and
nothing about whether the work is succeeding or how long it now takes. A cancelled run (a
client that hung up) is deliberately not counted as a failure, or a page full of users
navigating away would read as an outage. The histogram's top finite bucket is `600` — the run
deadline itself — so anything past it is a run that outlived its own limit.

**Alert on a non-zero `agent_studio_unknown_model_calls_total` rate.** A model id missing from
`src/domain/llm/models.ts` still runs, but its usage is booked at **$0** — the miss is
invisible in exactly the cost dashboard it corrupts. Each miss also logs `[cost] unknown model
id` once.

Counters are per-process and name **no project, user or model**; the only label any of them
carries is a histogram's `le`. A label whose values are unbounded turns one metric into a time
series per value, which is also why unknown model ids are counted rather than labelled.

## Logging

Every top-level run gets a **correlation id** when the run bracket admits it, carried in an
`AsyncLocalStorage` and stamped on every log line the run produces:

```
[mcp run=… trace=…] session 404 — re-handshaking
```

It is deliberately **not** the trace id: traces are sampled on the non-agent paths
(`TRACE_SAMPLE_RATE`, default `0.1`), so a trace id as the correlation id would leave nine out
of ten prompt and image runs with nothing to correlate on — and sampling does not favour the
runs worth reading logs for. Where a trace does exist, both ids appear.

Work started outside a request uses the id an operator can already see: a **webhook delivery**
carries the delivery id from its history row, a **Slack event** carries the Slack event id.

`src/shared/logger.ts` is the only place in the codebase that writes to the console, pinned by
`tests/architecture.test.ts`.

## Tracing

Agent runs are **always** traced. Non-agent and image predict runs are sampled at
`TRACE_SAMPLE_RATE`.

Traces are visible on each project's **Traces** tab to the owner and configured admins only —
they hold other users' runtime inputs and outputs. Spans keep only bounded metadata: character
counts, tokens, cost, duration, subagent trace ids. **Raw prompts and tool results are not
stored.** Each trace also carries the `actor` that caused the run.

## Row retention

Traces, usage rows, chats and their messages, trigger deliveries, inbound A2A tasks, Slack
dedup claims and Better Auth session rows all carry a unix-seconds `expiresAt`.

> **Enable TTL on the `expiresAt` attribute of the production table.** Nothing in the
> application does this; `scripts/init-local-table.ts` does it for local only. Without it,
> every row above accumulates forever.

| Rows | Default | Variable | Measured from |
|---|---|---|---|
| Traces (+ their deletion references) | 30 days | `TRACE_RETENTION_DAYS` | trace `createdAt` |
| Usage | 400 days | `USAGE_RETENTION_DAYS` | the usage row's date |
| Chats + messages | 180 days | `CHAT_RETENTION_DAYS` | last activity / message `createdAt` |
| Trigger deliveries | 30 days | `TRIGGER_RUN_RETENTION_DAYS` | delivery start |
| Inbound A2A tasks | 1 day | `A2A_TASK_RETENTION_DAYS` | last write |

Usage is kept longest because the dashboard queries up to 184 days back. A trace and its
deletion reference share one expiry so the reference never dangles.

DynamoDB's physical purge is only eventually consistent (up to ~48h), so **reads also filter
out already-expired rows**. `traceRepository` keeps pulling bounded pages until its `Limit` is
filled with live rows, because DynamoDB applies `Limit` before the app-side filter.

## Spend and load guards

Both hang off the run bracket (`src/application/execution/runBracket.ts`) and **fail in
opposite directions on purpose**.

### Daily cost guard — fails open

Per-project UTC-day thresholds, set under **Project Settings → Daily cost limits**:

- `alertThresholdUsd` — post a notification once, keep running.
- `blockThresholdUsd` — refuse every run for the rest of the day. Every execution entry point
  answers `429` with `Retry-After` set to the seconds until 00:00 UTC, which is exactly when
  the refusal stops being true.

Notifications go to `alertSlackChannel` through the project's own Slack bot, once per
threshold per day (a conditional write on the usage row, so two instances crossing together
still post once). **With no channel or no bot configured the thresholds still block** — a
missing notification path must not disable the guard.

**What it bounds, and what it does not.** An agent run buffers its usage and flushes once at
the end, so the check that admits a run cannot see what already-running runs have spent: runs
starting together all pass, and the block becomes true on the check that follows the flush. It
is a daily backstop against a runaway loop or a heavy caller — not a hard ceiling and not a
rate limit. Every read or write failure inside it fails open: the guard must not become a
second way for a storage blip to stop the platform.

### Concurrency guard — fails closed

`MAX_CONCURRENT_RUNS_PER_ACTOR` (default 10) per caller; inbound A2A has its own
`MAX_CONCURRENT_RUNS_A2A` (default 50) because its actor id is a constant. `0` turns a limit
off. Over the limit, a run is refused with `429` and a short `Retry-After` — refused **before
it starts**, so it records no usage and no trace.

Two properties matter operationally. Slots are **leased rows in DynamoDB, not process
memory**, so the limit is exact and does **not** multiply by instance count, and an instance
killed mid-run releases its hold when the lease expires rather than leaking it forever. And
the guard **fails closed** — opening it when the store is unreachable would add load exactly
when the store cannot take it. The design is in
[ARCHITECTURE.md](ARCHITECTURE.md#the-run-bracket).

This pair is the fast-acting half of a set. Per-run bounds (`MAX_RUN_DURATION_MS`, the turn
guard, tool-result caps) bound one run, and the chat run lease bounds one chat, but neither
stops the same person opening twenty chats or calling `/predict` in a loop — and the daily
cost guard only reacts once the money is spent.

## Schedule ticker

Schedule triggers fire only when something ticks `POST /api/triggers/scan` with
`X-Scan-Token: $SCHEDULE_SCAN_TOKEN` — on the EKS target, a Kubernetes CronJob (manifests
live in the GitOps repository). The contract the ticker has to meet, and nothing more:

- **Cadence ≤ 1 minute.** The scan looks back a fixed 10-minute catch-up window, so a missed
  tick or a short outage loses nothing; an outage longer than the window drops those
  occurrences for good (bounded on purpose — it also bounds how many runs a recovery can
  start at once).
- **Duplicates are safe.** Any number of tickers may call any instance concurrently; each
  occurrence is claimed with a conditional write and exactly one claim wins
  ([ARCHITECTURE.md](ARCHITECTURE.md#schedules)).
- The summary is logged on every tick (and returned in the response): `repaired` > 0 means
  an instance died mid-firing, `invalid` > 0 means a stored cron/timezone no longer parses,
  `errors` > 0 means repository calls failed and were fenced off. A refused token logs a
  warning server-side — a 401 ticker is otherwise invisible from inside the cluster.

## Multi-instance caveats

| Behaviour | Bound by | Consequence |
|---|---|---|
| Runtime settings propagation | `SETTINGS_CACHE_TTL_MS` (5s) | A demoted admin or rotated A2A key keeps working elsewhere until the cache expires — invalidation on write is process-local. |
| MCP registry edits | `MCP_DISCOVERY_CACHE_TTL_MS` / `MCP_MAX_SERVER_TTL_MS` | An edit made on one instance goes unseen on the others for up to that window. |
| Managed MCP | — | **One app instance per host.** A managed container joins exactly one network namespace. |
| Metrics counters | — | Per-process. Aggregate across instances at the scrape layer. |
| Background work (`after()`) | — | A Slack event or webhook delivery interrupted by an abrupt instance loss is not resumed; the delivery row stays `running`. Schedule firings share the gap but their rows are repaired to `failed` by the next scan; extending that to Slack/webhook is the `trigger-durability` milestone. |

### Managed MCP after a redeploy

A managed container joins this app's own network namespace
(`--network container:<MANAGED_MCP_NETWORK_CONTAINER>`), which is the only way a loopback
address means the same thing at both ends. Docker resolves that name to a container **id**
when the workload starts and never re-resolves it — so replacing this app leaves the container
running in a namespace nothing can address: healthy to `docker inspect`, reachable by nobody.

`reconcile` (`src/application/mcp/managedMcpUseCases.ts`) is fired from `instrumentation.ts`
at boot and **never awaited**: it probes every managed entry and restarts the ones that do not
answer. It is not awaited because a single restart pulls an image and polls SSM for up to five
minutes, and blocking on that would hold the server before it listens — failing the very
container healthcheck the deployment depends on.

A `401` counts as an answer: recreating a container over a credential problem fixes nothing.
`status` reports reachability separately from liveness for the same reason — reporting only
liveness is what made this class of failure invisible.

## Operational checklist for a new deployment

- [ ] `STAGE=alpha|prod`, with `ADMIN_EMAILS` and `ALLOWED_EMAIL_DOMAINS` set (boot refuses otherwise)
- [ ] `DYNAMODB_ENDPOINT` **empty**
- [ ] `AES_ENCRYPTION_KEY` provisioned as a secret, and backed up — losing it makes every stored credential unreadable
- [ ] DynamoDB table created with `PK`/`SK`, `GSI1`, `GSI2`, and **TTL enabled on `expiresAt`**
- [ ] `PUBLIC_BASE_URL` set (Agent Cards, Slack manifests, OAuth callback)
- [ ] Task/instance role grants DynamoDB, and S3 + SSM if those features are used
- [ ] LB health check → `/api/ready` (or `/api/health` on a scaled fleet), restart check → `/api/health`
- [ ] Container `stopTimeout` ≥ `MAX_RUN_DURATION_MS`
- [ ] Prometheus scraping `/api/metrics`; alerts on `agent_studio_runs_failed_total`, `agent_studio_run_duration_seconds`, `agent_studio_unknown_model_calls_total`
- [ ] If schedule triggers are used: `SCHEDULE_SCAN_TOKEN` provisioned as a secret and a CronJob ticking `/api/triggers/scan` at most a minute apart
