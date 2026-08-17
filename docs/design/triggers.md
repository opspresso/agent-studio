# Triggers

Two ways something other than a person starts a run — a webhook delivery and a schedule
firing — plus the sweep that closes a row an instance died holding.

The ticker's contract and what its summary means are
[OPERATIONS.md](../OPERATIONS.md#schedule-ticker); the delivery endpoints are
[API.md](../API.md#triggers).

```ts
WebhookTrigger  { projectName, triggerId (slug), kind: "webhook", description, enabled,
                  secret (AES-encrypted, masked on read), variables?, payloadMode,
                  allowConcurrent, createdAt, updatedAt }
ScheduleTrigger { …same base…, kind: "schedule", cron, timezone (IANA), message? }
```

- **A project has one webhook and any number of schedules.** The webhook is the trigger row
  under the reserved id `PROJECT_WEBHOOK_ID`, delivered at `POST /api/webhook/{project}` —
  the project name is the whole address, so nobody names it and the console is a switch that
  writes the row the first time it goes on. It stays a trigger row because everything a
  delivery needs already lives there: the secret, the firing history, the idempotency claim,
  the overlap lease, the project cascade delete. A second entity would have re-derived each
  of them. The "one webhook" part is structural rather than conventional: `admitDelivery`
  takes a project name and resolves the id itself, so no caller can address another row, and
  `create` refuses a webhook under any other id (which would mint a secret with no door) as
  well as a schedule under this one. `projectWebhookPath` in `src/domain/trigger/types.ts` is
  the only place the address is built.
- Triggers and their delivery history both live in the **project partition**, so the project
  cascade delete already removes them and a trigger's runs are one `begins_with`. Run rows
  carry a TTL, because a delivery log is not a record to keep.
- **Published only**, via `resolveRunnableVersion` — a draft is configuration in progress, and
  an external system firing at one would run whatever an editor happened to have saved.
- `triggerId` is a slug under the same rule as a project name, normalised client-side by the
  shared `toSlug` and enforced by the schema.
- The secret is compared in constant time **before** the enabled flag is read, so a disabled
  trigger cannot answer a wrong secret differently from an enabled one — that difference is an
  oracle for which triggers exist.
- `Idempotency-Key` is claimed with a conditional write (24h TTL), the same shape as the Slack
  event claim.
- `allowConcurrent: false` (the default) is enforced by **reusing a run slot**: "at most one
  in flight, and a dead instance's hold expires" is exactly what `RunSlotRepository` already
  is. Off by default, because a webhook firing faster than the run takes would otherwise pile
  runs up until the cost guard notices.
- `payloadMode` decides what the payload becomes. `variables` flattens its scalar top-level
  fields over the trigger's fixed ones — only strings can be substituted into a template, so a
  nested object is dropped rather than rendered as `[object Object]`. `message` serialises it
  into the user turn, which is what an agent project can reason about.
- **Every refusal past the door is a history row with a status**, including a skip (project
  gone, no published version, a run already in flight): an operator must be able to tell "it
  never fired" from "it fired and failed" without reading logs. What the door itself turns
  away — no webhook configured, a wrong secret, a disabled trigger, a duplicate
  `Idempotency-Key` — leaves no history row: those are the delivery's own answer (`404`,
  `401`, a `202` with its status), and a wrong secret must not write anything.
- The endpoint answers **202** and runs through `after()`, like the Slack path: a run here can
  last ten minutes and no webhook sender waits that long. An instance lost mid-delivery leaves
  a row stuck in `running`, which the [repair sweep](#repairing-a-lost-firing) finishes as
  `failed` — driven by the scan tick and by the trigger's own next delivery, so a deployment
  with no ticker is covered too. Slack keeps the gap on purpose: a lost event leaves no row to
  finish, only a user without an answer, and re-running it collides with the non-idempotence
  the schedule decision already ruled on.

## Schedules

**The scheduler boundary** — the deployment decision this feature waited on — is a
**Kubernetes CronJob ticking an authenticated endpoint** (`POST /api/triggers/scan`, shared
token, once a minute). The ticker holds no state and no cron knowledge: which occurrences are
due, who wins each one, and what runs is all decided in `scanSchedules`, so ticking twice,
from two places, or late is safe. The alternatives lost on state: EventBridge Scheduler puts
per-trigger CRUD in the AWS control plane — a second copy of the trigger table that can drift
from the real one — and a dedicated worker Deployment duplicates the whole runtime for a poll
loop the app can already serve. Three consumers were weighed, not one: Slack events and
webhook deliveries share the same ack-then-`after()` durability gap, and a stateless tick
against claimed work generalises to both — but migrating them is deliberately **not** part of
this decision; at three consumers it stops being a deployment choice and becomes a rewrite of
three execution paths. What the tick did take on afterwards is the *ledger* half of that gap
for webhooks, which needs no migration at all — see below.

- **"Exactly once" is the claim's property, not the ticker's.** Each occurrence (a UTC minute
  instant) is claimed with the same conditional write that dedups webhook deliveries, key
  `schedule:{instant}`. Any number of instances may scan concurrently; one write wins.
- **A claim is permanent — a crashed firing is not re-executed.** A run is not idempotent (its
  tools have side effects) and the next occurrence is the natural retry. What a lost instance
  leaves behind is a row stuck in `running`, which the repair sweep below finishes.
- **One trigger's failure is its own.** Every repository call in the tick is fenced per
  trigger and per occurrence; a throw after a claim was won writes a skip row — the claim is
  never offered again — and lands in the summary's `errors` count instead of aborting the
  tick with earlier claims stranded.
- **Cron evaluation has one owner**, `src/domain/trigger/cron.ts`: five standard fields read
  as wall clock in the trigger's IANA timezone, occurrences keyed by UTC instant — so DST
  needs no special cases (a spring-forward time never occurs; a fall-back time occurs twice,
  each instant its own claim).
- The scan looks back a bounded **catch-up window** (10 minutes): a missed tick or a short
  scanner outage loses nothing, anything older is missed for good — which also bounds how many
  runs a recovery can start at once. Overlapping windows are safe; the claim deduplicates.
  Occurrences older than the trigger's **last edit** never fire, so creating or re-enabling a
  schedule mid-window cannot back-fire instants from before the operator's decision. With
  overlap disallowed, catch-up runs the **newest** occurrence and records the stale ones as
  superseded rather than executing them late. One tick's admitted firings are driven through
  a bounded pool (8), not one background task each.
- Schedule rows alone carry `GSI1` (`TYPE#SCHEDULE`), so one index query enumerates them
  across projects and webhook rows stay invisible to the firing scan. The repair sweep below
  reaches both, by a different route and for a reason.
- A schedule has **no secret and no payload**: nothing external presents credentials, and
  every firing runs the trigger's fixed `variables`/`message` against the published version,
  attributed to the `schedule` actor kind.

## Repairing a lost firing

Both kinds acknowledge first and run in `after()`, so an instance killed mid-firing leaves a
row claiming a run is in flight when nothing is. `repairLostRuns`
(`src/application/trigger/repairLostRuns.ts`) is the single owner of when that row is dead and
what closes it, for **both** kinds: a `running` row older than `RUN_LEASE_SECONDS` plus a
ten-minute margin is finished as `failed`. The margin is not a tick's worth of slack —
`startedAt` is stamped when the firing is *admitted*, not when the backgrounded run starts, so
it has to cover the distance between the two. Repairing late is cosmetic; repairing a live run
brands a healthy instance as lost.

It corrects the **ledger, not the work**. Re-running is what the schedule crash policy already
ruled out, and a webhook has no next occurrence to retry into anyway.

**Two callers, because one tick is not a guarantee.** The scan sweeps every project on a gated
tick; a webhook delivery sweeps its own trigger as it finishes. The second is what covers a
deployment that serves webhooks and configures no ticker at all — a supported shape
([OPERATIONS.md](../OPERATIONS.md)), and one where the tick-only sweep would leave every stranded
row `running` forever. The delivery's sweep runs after its own row is closed and reads a window
a whole lease in the past, so it can neither delay the sender nor mistake its own firing for
wreckage. It costs one bounded query per delivery — paid on every firing rather than on a tick,
which is the price of not depending on a component the deployment may not have.

**The window is bounded by start time, not by recency.** `listRuns` takes a `startedBefore`
bound that maps onto the sort key, because the row a sweep is looking for is by definition old:
a trigger taking ten deliveries a minute writes hundreds of rows inside one lease, and the
newest fifty of those never include the one that needs finishing — it only sinks further the
longer it stays stranded. Bounding the query costs the same read and asks the right question.

**The sweep walks projects rather than an index**, which is the design decision here. Schedule
rows carry `TYPE#SCHEDULE` because the tick fires them every minute — enumeration is that
scan's hot path. Repair is the opposite: gated to every fifth minute, and run only to find
wreckage. Granting webhook rows a matching index would cover only rows written *after* it
existed, and a webhook trigger predating the repair is exactly the one most likely to have
stranded a row already — so the index would miss the rows it was added for. `projects.list()`
plus one trigger query per project reads everything that exists today and needs no backfill.
Each project and each trigger is fenced: one unreadable partition costs the sweep a count in
`errors`, not the tick.

