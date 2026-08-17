# Records a run leaves

Three ledgers with different readers: an audit row for a sensitive act, usage rows for what
was spent and by whom, and a trace for how one run went.

Retention, sampling and who may read a trace are
[OPERATIONS.md](../OPERATIONS.md#row-retention). What a trace deliberately does not store is
[SECURITY.md](../SECURITY.md#data-exposure-and-retention).

## Audit records

A sensitive act leaves a row, not only a log line, and the two are kept side by side because
they answer to different readers. A log line reaches whoever is already tailing the stream, is
retained by whatever ships it, and cannot answer "who changed the admin list last quarter". An
audit row answers exactly that and nothing else.

```ts
AuditEvent { eventId, actorEmail,
             action: 'secret.reveal' | 'secret.rotate' | 'secret.revoke'
                   | 'project.admin-override' | 'settings.update'
                   | 'project.delete' | 'registry.delete' | 'registry.adopt'
                   | 'artifact.delete' | 'member.set-tier',
             target,        // `kind:name` — `project:my-bot`, `skill:pdf-reader`
             detail?, createdAt }
```

**One writer**, `recordAudit` (`src/application/audit/recordAudit.ts`), pinned by
`tests/architecture.test.ts`. Every recorded act goes through it; a second writer would spell `target` its
own way, and a filter that worked for reveals would quietly return nothing for deletions —
which is the characteristic failure of a drifted audit trail, since it looks like an absence
of events rather than a bug. The store is **pushed in** by the composition root for the same
reason `setAdminCheck` is: a call site that had to pass it could forget, and one unrecorded act
is indistinguishable from one that never happened. `src/instrumentation.ts` wires it on the
**awaited** boot path rather than leaving it to the composition root's own import: not every
recording route needs something from the container — the A2A-key reveal needs nothing — and a
request served before that floating import resolved would reveal a credential and record
nothing.

**A failed write is logged, not thrown.** The act already happened; refusing it afterwards
would turn a storage blip into an outage of every sensitive operation at once. The pre-existing
`log.warn` lines at each site are deliberately kept for exactly this case — they are what
remains when the audit store is the thing that failed.

`action` is a closed set so the reader is a filter rather than a text search, and so recording
a new kind of act is a deliberate edit. `detail` never carries a credential: a settings write
records *which* keys moved, never their values, and two of those keys are secrets.

Rows are keyed by the **UTC day** they happened on and read a day at a time, the shape usage
already uses — it keeps a deployment's whole history from appending to one partition. Nothing
in the app updates or deletes one; expiry is the table's TTL. A record its subject can amend is
not a record, and it is what makes a *deleted* project's owner still answerable, since the
cascade takes every other row that knew.

## Usage and cost attribution

Daily per-project per-model aggregates (see the [key map](../ARCHITECTURE.md#dynamodb-single-table-design)). The
dashboard reads `USAGEDATE#{date}` GSI partitions across a range and regroups client-side by
project / provider / model.

**The cached share of the prompt is one of the metrics**, not something inferred from the
bill. `calculateCost` has always read `prompt_tokens_details.cached_tokens` to price the
input, and then dropped the count — so a prompt that stopped being cacheable cost more per
turn while calls, tokens and the answer all looked exactly as they had. It now rides on
`UsageInfo` (and therefore the `usage` chunk), into the daily rows as `cachedTokens.{model}`,
and onto each model span of a trace, where a cache regression is legible per turn: the first
turn of a run is cold by definition, and a broken cache is every later turn being cold too.
The breakdown table renders a **blank** where nothing reported one — `0%` would claim a cold
cache for a channel that simply does not report the field.

**Who spent it is a second row, not another dimension on the first.** Projects are a shared
catalog — any signed-in user may run any project — so the project name does not identify the
spender. `RunActor { kind, id }` (`src/domain/execution/actor.ts`) names one:

| Kind | Id | Why |
|---|---|---|
| `user` | email | — |
| `project-token` | the **owner's** email | A token authenticates as them; the *kind* is what keeps a machine's spend apart from that person's own runs — and out of their personal tier budget, which only `user` rows feed |
| `slack` | Slack user id | Slack hands over no email, and guessing a mapping would bill the wrong person |
| `telegram` | Telegram user id | The same reason; Telegram hands over a name and a username, and neither is an address |
| `a2a` | the constant `shared-key`, or the client key's name | The shared key names nobody; a named client key names its holder, so their runs are attributed and bounded per client |
| `webhook` | `{project}:{triggerId}` | — |
| `schedule` | `{project}:{triggerId}` | — |

The split into a separate `ACTOR#{date}#{actor}` row is deliberate. `UsageRow` holds a map per
metric keyed by model; keying those by `actor|model` instead would grow one item with the
number of distinct callers, and a busy project would approach the 400KB item limit within a day
— while the dashboard, which only ever asks for project totals, would pay to read every caller
on every request. A separate row in the same partition keeps both reads exactly as wide as
their question, and the project cascade already deletes the whole partition.

The project total is written **first and unconditionally**; the actor row follows. Attribution
is additive — a path that cannot name its caller still records the spend it caused.

**The actor is the run's, not the turn's.** `createUsageAggregator` is bound with it once, so
the calls a subagent transfer makes on another project are still attributed to whoever started
the run. `RunOrigin { actor?, caller?, conversation?, ancestry }` carries them down every
transfer hop — `caller` being who the actor is *in words*, for versions that opt into caller
context; a subagent is answering, and billing, the same person as its parent, so the values
always travel together as one rather than as parameters threaded side by side through eight
signatures.

**`conversation` is which thread the run is in**, `RunConversation { surface, id }`, spelled
as one key by `conversationKey` (`src/domain/execution/actor.ts`, which also owns
`conversationOf` — the one place a foreign id is normalised for a header and a storage key).
Each surface has its own builder and its own spelling, and a firing has none:

| Surface | Key | Built by |
|---|---|---|
| chat | `chat:{chatId}` | `chatConversation` (`src/domain/chat/conversation.ts`) |
| Slack | `slack:{channel}:{threadTs}` — the thread, root message included | `slackConversation` (`src/domain/slack/conversation.ts`) |
| inbound A2A | `a2a:{clientActorId}:{contextId}` — the caller's grouping, under the caller | `a2aConversation` (`src/domain/a2a/conversation.ts`) |
| `predict` / `chat/completions` / `agent` | `api:{callerDigest}:{X-Conversation-Id}` — opt-in, scoped to the caller without carrying their email | `requestConversation` (`src/app/api/projects/_lib/conversation.ts`) |
| webhook / schedule | — | a firing takes no follow-up question, so it is not a conversation of one |

Two consumers read it, and only two: the outbound A2A transfer, which continues the remote
conversation the first question opened ([A2A](agents-a2a.md#a2a)), and the MCP header that tells a
stateful server which conversation is asking ([MCP](mcp.md)). Neither the actor (a person is in
many conversations) nor the ancestry (a chain of projects, not of turns) could stand in for
it, which is why it is a field of its own. The trace records the key too — for correlation
when reading one trace; nothing indexes or filters by it yet, so "every run of this thread" is
not a query anything answers today.

`conversationOf` **encodes rather than replaces**: whitespace, control characters, anything
outside printable ASCII and `%` itself become `%XX` over their UTF-8 bytes, so a UUID or a
Slack address reads back unchanged and two different foreign ids — an A2A `contextId`, a
caller's header — never become one conversation. Replacing them with a placeholder was the
first version, and it made every Korean word two underscores: two conversations, one memory.
Past 512 encoded characters there is no conversation rather than a shortened one, for the
same reason; the API surface answers 400 for that, since a caller that declared a
conversation and silently ran without one would have no way to know.

## Traces

```ts
Trace     { traceId, projectName, versionName, projectType, actor?, ancestry?, conversation?,
            status: 'completed' | 'turn-limit' | 'failed' | 'cancelled',
            spans: TraceSpan[], spansDropped?, warnings?,
            startedAt, endedAt, durationMs, error?, createdAt }
TraceSpan { spanId, kind: 'model' | 'tool' | 'subagent', name, author?,
            startedAt, endedAt, durationMs, status: 'ok' | 'error', input?, output? }
```

Agent runs always persist model/tool/subagent spans; non-agent and image predict runs are
sampled. Spans keep only bounded metadata — character counts, tokens, cost, duration, subagent
trace ids. **Raw prompts and tool results are not stored.** Retention, sampling and who may
read a trace are in [OPERATIONS.md](../OPERATIONS.md#tracing).

**A trace is assembled from the same chunks the user sees.** `TraceRecorder`
(`src/application/trace/recorder.ts`) observes the `EngineChunk` stream instead of being
called from instrumentation points scattered through the loop, so a new tool or builtin is
traced without anything having to remember it. It reads the ending through `runTermination`,
which is what keeps a child's turn limit from marking its parent's trace.

**`turn-limit` is a status of its own** because a run that reached its ceiling is not a run
that finished. Recording it as `completed` made the one run worth investigating read as
normal on the traces page — and that stays true now that the last turn wraps up rather than
falling silent: the answer exists, but it was written with the budget spent and without the
tools the plan was still using.

**One transfer is one span, whatever depth it reached.** A subagent entry is keyed by the
direct child *and* its trace id, so a deeper hop rolls into the transfer that started it while
two transfers to the same agent stay two spans. The chain is then readable in both directions:
`ancestry` upwards to the top-level run, a span's subagent trace id downwards into the child's
own trace.

**Every accumulator is bounded**, because a trace is a single DynamoDB item: 100 spans, with
the rest counted in `spansDropped` rather than vanishing; 20 warnings; and 1,000 characters of
any one error or warning string.

