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
docker build -t agentdure .
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

Pair this with a container `stopTimeout` at least as long as `MAX_RUN_DURATION_MS` (default
10 minutes, so 660s covers the deadline and the drain behind it) — which is what the
deployment checklist asks for. A shorter grace period cuts streams that would have completed.

## Metrics

`GET /api/metrics` is a Prometheus scrape endpoint — unauthenticated and dependency-free like
`/api/health`, because it is scraped in-cluster on the pod address.

| Metric | Type | Use |
|---|---|---|
| `agentdure_active_runs` | gauge | **The autoscaling signal.** |
| `agentdure_runs_started_total` | counter | Throughput. |
| `agentdure_runs_finished_total` | counter | Throughput. |
| `agentdure_runs_failed_total` | counter | **Alerting signal.** Cancellations are not failures. |
| `agentdure_run_duration_seconds` | histogram | **Alerting signal.** Buckets `0.5 … 600`. |
| `agentdure_unknown_model_calls_total` | counter | Correctness signal — see below. |
| `agentdure_unknown_models` | gauge | Distinct unregistered model ids seen. |
| `agentdure_draining` | gauge | `1` once shutdown began. |

**Autoscale on `agentdure_active_runs`, not CPU.** Runs are I/O bound — an instance
saturated with them still reads as idle CPU.

**A chat run no longer sheds when its reader leaves.** A closed tab means the reader left, not
stop (see [ARCHITECTURE.md](ARCHITECTURE.md#a-run-outlives-its-connection)), so the gauge now
counts runs nobody is watching — a more honest number, but a page full of users reloading no
longer drops load. Only a Stop press, or the run deadline, ends one early. Abandoned chat runs
also bill in full and hold a per-caller run slot until they finish; `MAX_CONCURRENT_RUNS_PER_ACTOR`
and the cost guard are what bound that.

**Alert on failures and duration, not the gauge.** The gauge says how busy an instance is and
nothing about whether the work is succeeding or how long it now takes. A cancelled run (a
client that hung up) is deliberately not counted as a failure, or a page full of users
navigating away would read as an outage — this still applies to `/predict`, `/agent`,
`/chat/completions` and Slack, which do abort on their caller's signal; chats reach it only
through a Stop press. The histogram's top finite bucket is `600` — the run deadline itself —
so anything past it is a run that outlived its own limit, and an abandoned chat run left to
the deadline lands there as a *failure*.

**Alert on a non-zero `agentdure_unknown_model_calls_total` rate.** A model id missing from
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
[mcp run=… trace=…] skipping server 'shared-mcp': …
```

It is deliberately **not** the trace id: traces are sampled on the non-agent paths
(`TRACE_SAMPLE_RATE`, default `0.1`), so a trace id as the correlation id would leave nine out
of ten prompt and image runs with nothing to correlate on — and sampling does not favour the
runs worth reading logs for. Where a trace does exist, both ids appear.

Work started outside a request uses the id an operator can already see: a **webhook delivery**
carries the delivery id from its history row, a **Slack event** carries the Slack event id.

`src/shared/logger.ts` owns writing to the console, pinned by `tests/architecture.test.ts`
with two standing exemptions: `domain`, which imports nothing and so cannot reach the logger —
the `[cost] unknown model id` warn above is one, and carries no `run=` suffix for exactly that
reason — and the API-reference page, whose SDK sample merely *displays* a `console.log`.

A failed request reaches the log through `apiError`, at a level that says whose fault it was:
`error` for a throw it could not account for — the caller gets `Internal server error` and the
message stays here — and `warn` for a typed `5xx`, whose message the caller already has. A
`4xx` is logged nowhere: it is the API working, and recording every rejected body would bury
the two above. This is why an upstream refusal is greppable at all — while `apiError` answered
typed errors without logging them, giving a failure a type quietly took it out of the record.

## Tracing

Agent runs are **always** traced. Non-agent and image predict runs are sampled at
`TRACE_SAMPLE_RATE`.

Traces are visible on each project's **Traces** tab to the owner and configured admins only —
they hold other users' runtime inputs and outputs. Spans keep only bounded metadata: character
counts, tokens, cost, duration, subagent trace ids. **Raw prompts and tool results are not
stored** — with one caveat: a trace's `error` and `warnings` keep up to 1,000 characters of
the failure text verbatim, and a provider or tool error string can embed content. Each trace
also carries the `actor` that caused the run.

With `OTEL_EXPORTER_OTLP_ENDPOINT` set, every persisted trace is also exported as OTLP spans
(see [CONFIGURATION.md](CONFIGURATION.md#observability-and-retention)) — same timestamps, the
app trace id as the `app.trace_id` attribute, and the same bounded metadata. The DynamoDB row
stays the record; a collector outage costs `[otel]` log lines (the SDK's internal error
channel is routed to the app logger), never runs. The export batch is flushed when the
instance begins draining, so a rollout keeps its last spans.

## Row retention

Traces, usage rows, chats and their messages, trigger deliveries, inbound A2A tasks, Slack
dedup claims and Better Auth session rows all carry a unix-seconds `expiresAt`, as do three
fixed-lifetime row kinds: webhook idempotency claims (24h), MCP OAuth in-flight states
(10 min) and run concurrency slots (the lease length — concurrency stays correct without TTL,
but the rows accumulate one per run).

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
| Audit records | 400 days | `AUDIT_RETENTION_DAYS` | the act's `createdAt` |
| Chat run replay logs | run lease + 15 min | *(derived, not configurable)* | the row's write |

Usage and audit rows are kept longest — the dashboard queries up to 184 days back, and the
questions an audit row answers ("who changed the admin list last quarter") are asked long
after the act. A trace and its deletion reference share one expiry so the reference never
dangles. Chat run replay logs are the exception to the whole table: they are a buffer a
disconnected reader catches up from, not a record, and their window is derived from
`MAX_RUN_DURATION_MS` rather than configured — one that could be set shorter than a run would
leave a resume with a hole in the middle of it.

DynamoDB's physical purge is only eventually consistent (up to ~48h), so **reads also filter
out already-expired rows**. `traceRepository` keeps pulling bounded pages until its `Limit` is
filled with live rows, because DynamoDB applies `Limit` before the app-side filter.

What runs produce lives outside the table, and **expiry there is the bucket's job**. An
artifact row names the object and can delete it deliberately (the gallery's delete button does
exactly that), but nothing sweeps on expiry: a row disappears by DynamoDB TTL, which the
application never observes, so there is no moment at which it could cascade.

**Attach a lifecycle rule to each prefix**, matched to the row window:

| Prefix | Window | Holds |
|---|---|---|
| `artifacts/image/` | `ARTIFACT_RETENTION_DAYS` | Generated and attached images |
| `artifacts/document/` | `ARTIFACT_RETENTION_DAYS` | Documents a tool rendered |
| `images/` | `CHAT_RETENTION_DAYS` | The pre-artifact layout; still read, never written |

The two settings cannot be reconciled by the app, and both mismatches are visible: rows
expiring first leaves objects nothing names — an invisible leak, since only an inventory could
find them again — while objects expiring first leaves a gallery listing previews that 404. The
UI renders that second case as "no longer available" rather than a broken image. Run
`scripts/backfill-artifacts.ts` once to give pre-artifact objects rows, or leave them to the
`images/` rule. See [SECURITY.md](SECURITY.md#data-exposure-and-retention).

## Spend and load guards

Both hang off the run bracket (`src/application/run/runBracket.ts`) and **fail in
opposite directions on purpose**.

### Cost guard — fails open

Per-project thresholds over two UTC windows, set under **Project Settings → Cost limits**:

- `alertThresholdUsd` / `monthlyAlertThresholdUsd` — post a notification once, keep running.
- `blockThresholdUsd` / `monthlyBlockThresholdUsd` — refuse every run for the rest of the
  window. Every execution entry point answers `429` with `Retry-After` set to the seconds
  until the window rolls over — 00:00 UTC for the day, the first of the next month for the
  month — which is exactly when the refusal stops being true. The month's spend is its daily
  rows summed: one bounded query, no separate aggregate to drift — which is why
  `USAGE_RETENTION_DAYS` has a floor of a full month (see
  [CONFIGURATION.md](CONFIGURATION.md#observability-and-retention)); rows expiring
  mid-month would silently under-count the window.

Notifications go to `alertSlackChannel` through the project's own Slack bot, once per
threshold per window (a conditional write — on the usage row for the day, on a
`MONTHCLAIM#{yyyy-MM}` row for the month — so two instances crossing together still post
once). **With no channel or no bot configured the thresholds still block** — a missing
notification path must not disable the guard.

**What it bounds, and what it does not.** An agent run buffers its usage and flushes once at
the end, so the check that admits a run cannot see what already-running runs have spent: runs
starting together all pass, and the block becomes true on the check that follows the flush. It
is a per-window backstop against a runaway loop or a heavy caller — not a hard ceiling and
not a rate limit. Every read or write failure inside it fails open, and each window fails
open on its own: a throttled month query skips the monthly check, never the daily one. The
guard must not become a second way for a storage blip to stop the platform.

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
- **One tick drives at most 8 firings at a time** (`MAX_CONCURRENT_FIRINGS`). A 09:00 shared
  by every project would otherwise become that many simultaneous runs on whichever instance
  served the tick, and the per-caller concurrency guard cannot bound that fan-out — each
  trigger is its own actor, so every one of them is under its own limit.
- The summary is logged on every tick (and returned in the response): `repaired` > 0 means
  an instance died mid-firing, `invalid` > 0 means a stored cron/timezone no longer parses,
  `errors` > 0 means repository calls failed and were fenced off. A refused token logs a
  warning server-side — on all three token endpoints, because a 401 ticker is otherwise
  invisible from inside the cluster.

## Catalog reindex

`POST /api/catalog/reindex`, same `X-Scan-Token` as above, another CronJob. Unlike the
schedule ticker there is no window to miss: the tick rebuilds the index from the registries as
they are now, so a skipped run only delays discovery of whatever changed since the last one.
**Hourly is ample**; a minute-by-minute tick would probe every MCP server that often for
nothing.

- **Duplicates are safe.** Keys are derived from the entry, so a second pass writes the same
  records and computes the same leftovers.
- The tick returns as soon as the work is handed off; the outcome is in the log line —
  `indexed`, `removed`, and `undiscovered` naming servers whose tools could not be listed.
  A server needing an OAuth connection is expected to be in that list: it is still indexed at
  server level, only without its tools.
- 503 has two causes, checked in this order: `SCHEDULE_SCAN_TOKEN` unset, which means the
  endpoint has no credential to authenticate a ticker with and refuses to scan for whoever
  asks; then `VECTOR_BUCKET` unset, which is a deployment without a catalog rather than a
  fault. Runs then offer exactly what their versions bound. The response body names which.
- **A completed plugins sync reindexes too**, on both paths (the console and the minute tick),
  so a merge to the plugins repo is discoverable without waiting for the hour. That reindex runs
  after the sync has committed and its report is persisted, so a failure is logged and swallowed
  — `reindex after plugins sync failed` in the log, repaired by the next tick.

## Plugins sync ticker

`POST /api/plugins/sync/scan`, the same `X-Scan-Token` again, a third CronJob. It pulls the
Agent Plugins repository (`PLUGINS_REPO`) into both registries so a merge lands without an
admin visiting the console. A minute apart is fine, because a tick that finds nothing costs
one request.

- **The head SHA is the shortcut.** A tick reads the repository's head first and stops there
  when it matches the last applied sync — one read against the ~30 blob reads a full
  snapshot takes. A stored report carrying a fenced write failure disqualifies the shortcut,
  so a re-run is what repairs it.
- **Duplicates are safe.** One sync runs per repository at a time, and the lease *refuses*
  the second rather than letting it double every GitHub read. A tick that loses that race has
  already answered `202`, and logs `sync tick did not run` at warn — ordinary overlap, not a
  fault. The console path surfaces the same refusal as a `409`.
- **A tick never deletes.** What the repository no longer carries is *reported* as orphaned,
  with the version bindings that would dangle; the removal selection exists only in the
  console. A merge that drops a plugin therefore cannot take a registry row with it
  unattended — see [SECURITY.md](SECURITY.md#request-authentication-for-machine-callers) for
  what that means for the token itself.
- The outcome lands in the persisted report (`GET /api/plugins/sync`) and in the log line.
- 503 means `SCHEDULE_SCAN_TOKEN` is unset, or `PLUGINS_REPO`/`GITHUB_TOKEN` are.

## Multi-instance caveats

| Behaviour | Bound by | Consequence |
|---|---|---|
| Runtime settings propagation | `SETTINGS_CACHE_TTL_MS` (5s) | A demoted admin or rotated A2A key keeps working elsewhere until the cache expires — invalidation on write is process-local. |
| MCP registry edits | `MCP_DISCOVERY_CACHE_TTL_MS` / `MCP_MAX_SERVER_TTL_MS` | An edit made on one instance goes unseen on the others for up to that window. |
| Managed MCP | — | **One app instance per host.** A managed container joins exactly one network namespace. |
| Metrics counters | — | Per-process. Aggregate across instances at the scrape layer. |
| Background work (`after()`) | — | A Slack event or trigger firing interrupted by an abrupt instance loss is **not resumed** — a run is not idempotent. Trigger rows of both kinds are repaired to `failed` by the sweep — on every fifth minute's scan tick (`REPAIR_EVERY_MINUTES`, because the sweep walks every project's triggers and reads their history, which is not worth doing every minute), and on the trigger's own next webhook delivery, so a deployment with no ticker configured still ends up with a correct ledger. A lost Slack event is deliberately not repaired — it leaves no row to finish, only a user without an answer. |

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
- [ ] If `S3_BUCKET_NAME` is set: the role's S3 grant covers **`artifacts/*` as well as
      `images/*`**, with all three of `s3:PutObject`, `s3:GetObject` and `s3:DeleteObject`.
      Each half of that has been wrong in production once:
      - **The prefix.** Runs write `artifacts/<kind>/<id>.<ext>`; `images/` is only the
        pre-artifact layout, still read and never written. A grant scoped to `images/*`
        fails every write with `AccessDenied`, and the run *survives* it — the picture is
        shown and a warning says it was not kept, so nothing is down and nothing is stored.
      - **The actions.** `GetObject` is not optional: a read URL is pre-signed with the
        role's own credentials, so without it **every** image 403s — the gallery and the
        chat transcript alike, including rows written before. `DeleteObject` is what the
        gallery's delete button needs; without it a delete fails and leaves the row.
- [ ] If `S3_BUCKET_NAME` is set: the bucket is **private** (public-read is no longer needed),
      with lifecycle rules on `artifacts/image/`, `artifacts/document/` and the legacy
      `images/` prefix — see [Row retention](#row-retention). A missing rule on a new prefix
      is a silent leak: the rows expire and the objects do not
- [ ] LB health check → `/api/ready` (or `/api/health` on a scaled fleet), restart check → `/api/health`
- [ ] Container `stopTimeout` ≥ `MAX_RUN_DURATION_MS`
- [ ] Prometheus scraping `/api/metrics`; alerts on `agentdure_runs_failed_total`, `agentdure_run_duration_seconds`, `agentdure_unknown_model_calls_total`
- [ ] `SCHEDULE_SCAN_TOKEN` provisioned as a secret if any of the three ticks below are used — it authenticates all of them, and one (the plugins sync) writes both registries
- [ ] If schedule triggers are used: a CronJob ticking `/api/triggers/scan` at most a minute apart
- [ ] If `VECTOR_BUCKET` is set: a CronJob ticking `/api/catalog/reindex` hourly — a registry write never reindexes, so without this tick the only thing that refreshes the index is a completed plugins sync, and a hand-registered skill or server is never discovered
- [ ] If `PLUGINS_REPO` is set: a CronJob ticking `/api/plugins/sync/scan`; a minute apart is fine, since a tick with nothing to do reads one head SHA
