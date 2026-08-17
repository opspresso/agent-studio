# Chat

A private, owner-scoped conversation against an agent project — and the one surface whose
history is an unbounded input the platform itself owns. Attachments sit here because a chat
is where most of them arrive.

> **The persistence and replay invariants live beside the code.**
> `src/application/chat/AGENTS.md` is the authority on `run.ts` and `messageMapping.ts` —
> the ordering a resume rests on, what replay refuses, and where each budget applies. This
> file says why a run outlives its connection and why the log is a buffer rather than a
> record.

```ts
Chat { chatId, title, ownerEmail, projectName?, createdAt, updatedAt }
```

Messages are append-only with a `seq`. Chat execution uses the agent engine directly — no HTTP
self-call — and streams SSE to the client.

One chat carries **one run at a time**: `claimChatRun` (`src/application/chat/runLease.ts`)
takes a conditional-write lease on the chat row (`activeRunId`, expiring after
`RUN_LEASE_SECONDS`), and a second send while it holds is a `ChatConflictError` (409). This is
separate from the per-caller run-slot guard: that bounds a *person's* concurrency, this keeps
two runs from interleaving one chat's append-only history.

## A run outlives its connection

A chat run used to end when the browser did. The SSE layer aborted it on `cancel()`, so a
reload, a closed tab or a hard navigation left a half-written answer and a dangling user turn.
It now **detaches** instead: `detachOnReturn` (`src/shared/detachOnReturn.ts`) turns the
consumer's `return()` into "the reader left", keeps pulling the run to completion in the
background, and the route registers the remainder with `after()` so a graceful shutdown waits
for it. The chat routes therefore pass **no `AbortController`** to `sseResponse` — the one they
mint is wired to the cancel watch instead.

That makes stopping a run an explicit act: `DELETE /api/chats/{chatId}/runs/{runId}` writes
`cancelRequestedAt` on the chat row and `watchChatCancel` polls for it, because the instance
serving the press is not necessarily the one running the answer — the same shape the A2A
executor uses for `tasks/cancel`. The engine rethrows whichever abort it was given, so *which*
kind it was survives on the signal's reason and is read back by `endNoticeFor`: a stop and a
claim that has moved on each end the run the way a finished one ends, with their own note
streamed **and** persisted onto the message the run just saved.

To let a reader come back, `teeToRunLog` (`src/application/chat/runLog.ts`) keeps a **replay
log**: short-TTL rows in the chat's own partition, each carrying a batch of the run's frames.
It writes **nothing while a reader is attached** — they are seeing every frame already — and
flushes the whole run so far the moment the connection drops, then every 500ms after.
`GET /api/chats/{chatId}/runs/{runId}/stream` replays it from the start and follows it, and
`getChat` reports `activeRun` so a browser that reloaded knows what to ask for. Ordering is the
contract: **persist → terminal entry → release the lease**, which is why the lease release
lives in `runLog.ts` rather than in `runAndPersist`.

Two things the log deliberately cannot do. Image bytes never go in it (a note goes in their
place; the picture arrives with the persisted message, or not at all when no object storage is
configured — which the note says). And while one window is attached the log is empty, so a
second window watching the same run sees nothing until the first closes — reported after five
seconds rather than left looking stalled.

On the client the stream is owned by a module-level store (`src/app/chats/_lib/runStore.ts`),
above the router, so a navigation cannot interrupt a turn: components subscribe through
`useSyncExternalStore` and a view that remounts finds the run still going. The store folds
every frame into its entry as it lands but **notifies subscribers on a collection window**,
because a notification is a render of the whole thread; the window widens as the answer does,
since the render it schedules gets more expensive the more markdown there is to re-parse.
`MessageView` is memoised against a reference-stable message array so a streaming reply
redraws itself and nothing else.

The **viewport belongs to `use-stick-to-bottom`** (`ChatThread`), not to an effect: it follows
the reply only while the reader is already at the bottom, offers a jump-to-latest control when
they are not, and is overruled by exactly one thing — sending a message. What it replaced
scrolled on every render, which both trapped the reader at the bottom and, being a `smooth`
scroll restarted dozens of times a second, made the thread judder. Two constraints it imposes
are easy to undo by accident and are commented where they live: the jump control reads
`isNearBottom` (geometry) rather than `isAtBottom` (intent, and unavailable mid-resize), and
nothing inside the thread may be a scroll container on both axes, or it swallows the wheel
events the library follows. A stream that ends
without the `{ ended: true }` frame is a lost connection, not a finished run, so the store
asks `GET /api/chats/{chatId}/runs/{runId}` whether it is still going and reattaches to the
replay endpoint — from the start, which is safe because `reduceChunk` is a pure fold. Its
reconnect budget counts *consecutive* failures: a ten-minute reply survives any number of cuts
that reconnect cleanly, under a lifetime ceiling so a stream that opens and dies every time
still ends.

`ChatMessage` is a discriminated union on `role` (`user` | `assistant` | `tool`): a tool row
always carries `toolCallId`, an assistant row may carry `toolCalls`/`images`/`files`, a user row
may carry `images`/`documents`, and illegal combinations are unrepresentable. `files` are what a
run produced and a reader downloads; only the view resolves them to addresses, because unlike an
image a file is never fetched into a replayed turn.

A run persists **one flattened assistant message** holding the accumulated text, the run's
top-level `toolCalls` and any `warnings` it reported, preceded by its tool rows — including a
subagent's and a transfer's, which carry `author`/`displayOnly` so a reader sees what ran while
replay refuses them.

**Tool traffic is replayed**, which is the decision that makes a chat different from every
other surface: a chat is the one input source this platform owns and lets grow without limit,
so what a later turn is allowed to see has to be decided here rather than by the caller. Three
budgets bound it — the last N assistant turns, a tool-text budget, and a history budget over
whole runs — and only the third **reports its drops as a `warning` chunk**, because the other
two drop by design where it drops what the reader wrote.

The mechanics that follow from that (storage order within a turn is the reverse of the wire
order, pairing is scoped to one run because a tool-call id is unique only there, a call with no
stored result is dropped rather than orphaned) are traps rather than design, and
`src/application/chat/AGENTS.md` holds them in the detail an edit needs.

## Attachments

A turn may carry two kinds of attachment, and they take different routes.

**Images** travel as bytes. They become `image_url` content parts, the engine registers a
handle for each so a run can edit them, and the model must declare `imageInput` — sending a
part a text-only model rejects fails the whole turn.

**Documents become text at the surface that received them.** PDF, plain text, Markdown,
CSV/TSV, JSON, YAML, XML and HTML are read into the turn as text parts rather than as
provider-native file parts. That is a decision about this deployment rather than a
simplification: a model id may be served by the default router **or** by its own provider's
OpenAI-compatible endpoint (`LLM_PROVIDER_<NAME>_BASE_URL`), and those disagree about how — or
whether — a file part may be sent, while `ModelCapabilities` is per *model* and cannot express
a difference belonging to the channel. Text needs no capability gate at all, and it survives
chat persistence, replay and the PII filter unchanged.

| Piece | Owner |
|---|---|
| Caps, and which files are documents (`documentKind`) | `src/domain/llm/documentLimits.ts` |
| Extraction (a port — it needs a PDF parser) | `src/domain/llm/documentExtractor.ts`, adapter over `unpdf` in `src/infrastructure/llm/` |
| Budgets, warnings, and the wrapper the model reads | `src/application/llm/documentParts.ts` |
| Whether bytes are text at all | `decodeUtf8Text` in `src/shared/utf8Text.ts` |
| A user turn's body, sent and replayed | `turnContent` in `src/application/llm/documentParts.ts` |

**An all-text turn stays a string.** Only images make a content-parts array necessary, and
only images are gated on a model declaring it can take them. Wrapping text in parts merely
because a document is present would put a shape on the wire that no turn used before, for no
gain — the parts are concatenated anyway — and would give back exactly the channel-independence
that made text the right choice. `turnContent` owns that, for the send and the replay alike.

Two properties are load-bearing. **Nothing is lost quietly** — a truncated document, one that
failed to parse, one past the per-turn count: each becomes a `warning`, because a document
that contributed nothing looks exactly like a model that ignored it. And **a file that yields
no text is a reported failure, never an empty success**: "this is a scan with no text layer"
is actionable, while an empty string reads as "the document is empty".

`decodeUtf8Text` exists because `Buffer.toString("utf-8")` never throws — invalid sequences
become U+FFFD — so the naive decode turns a PDF into replacement characters and reports
success. It decides on the bytes (a UTF-8 round trip, plus a NUL check for ASCII UTF-16),
never on the declared content type, which is absent or wrong often enough to lose real files.
The same decision guards MCP tool results: a non-image `resource.blob` that is not text
travels as a `file` chunk (named in the result text as delivered to the user) while it fits
`MAX_TOOL_FILE_BYTES`, and past that is named and omitted rather than dumped.

