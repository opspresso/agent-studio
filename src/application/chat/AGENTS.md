# Chat Application Use Cases

Use cases for agent-backed chats. Pure orchestration over injected ports (`ChatDeps`);
no AWS/framework imports. Wiring to concrete adapters happens at the route boundary
(`src/app/api/chats/_deps.ts`), which also binds `executeAgent(executionDeps, params)`
into `ChatDeps.runAgent`.

**This file holds what must not break.** Why a run outlives its connection, why the log is a
buffer rather than a record, and why the viewport belongs to a library is
[docs/design/chat.md](../../../docs/design/chat.md).

## Files

- `deps.ts` — `ChatDeps` port bag + `AgentRunner` (bound engine call).
- `errors.ts` — `ChatError` subclasses carry the HTTP status the route surfaces.
- `title.ts` — first-message → title, truncated to 50 chars.
- `messageMapping.ts` — stored `ChatMessage[]` → OpenAI-shaped engine messages.
- `messageList.ts` — full transcript/tail reads over bounded sequence pages.
- `run.ts` — `resolveVersion` (published → latest fallback) and `runAndPersist`
  (tee the engine stream to the client, persist afterward). It does **not** release the
  run lease; `runLog.ts` wraps it and does.
- `runLease.ts` — `claimChatRun`: one in-flight run per chat, taken as a conditional
  write on the chat row (`activeRunId`, `RUN_LEASE_SECONDS`); a losing claim is a
  `ChatConflictError` (409). `isChatRunActive` answers the same claim as a yes or no,
  for a reader deciding whether to reconnect.
- `runLog.ts` — `teeToRunLog`: buffers the run's frames, writes them down once the reader
  leaves, and owns the terminal entry and the lease release.
- `replayRunLog.ts` — `openRunLogReplay`: replay the log from the start, then follow it.
- `cancelRun.ts` — `cancelChatRun` (persist the ask) and `watchChatCancel` (the running
  side's poll for it).
- `resolveImages.ts` — resolve a stored image per reader: the view signs its key, while a run
  restores the newest four as bounded inline bytes for editing and omits the rest; reports
  images that could not be restored so the caller can say so.
- `resolveFiles.ts` — the same for a file a run produced, carrying the filename to save as.
  Only the view calls it: a file's bytes never enter a replayed turn.
- `createChat.ts` / `sendMessage.ts` / `listChats.ts` / `getChat.ts` / `deleteChat.ts`.

## Design decisions (read before changing)

- **A run is not the request that started it.** The browser hanging up means the reader
  left; the run finishes anyway and persists its answer. The stop is explicit
  (`cancelChatRun` writes `cancelRequestedAt`, `watchChatCancel` polls for it and aborts),
  because the instance serving the press need not be the one running the answer.
- **A stop is not a failure, and the engine cannot say which it was** — it rethrows the
  abort it was given either way. The intent survives on the signal instead:
  `watchChatCancel` aborts with a reason, and `runAndPersist` reads it back through
  `endNoticeFor` to end the run the way a finished one ends — what streamed is persisted, the
  stream closes cleanly, and the reader gets the note as a warning. Without that the press
  answers itself with a red `This operation was aborted` over the partial answer, and the
  replay log keeps it as the run's error. Two details are load-bearing:
  - **It is handled in `runAndPersist`, not in the tee around it**, because this is the only
    place that can also put the note *on the message*. Wrapped outside, a stop reached the
    live reader and no further — the assistant message had already been written by the time
    the abort surfaced — so coming back to the chat showed a reply stopping mid-sentence with
    nothing to say why.
  - **Two reasons, not one.** `STOP_REASON` is something the reader did; `SUPERSEDED_REASON`
    is a claim that has moved on (the chat was deleted, or another run holds it) and ends this
    run *for* them. Reporting the second as "Stopped." blames a press that never happened.
- **persist → terminal entry → release the lease.** `teeToRunLog` wraps `runAndPersist`,
  so a reader that sees the terminal entry can fetch the chat and find the assistant
  message already there, and a reader that sees the claim gone has therefore already seen
  the terminal entry. Inside `runAndPersist` the terminal entry would land before the
  image uploads and the message writes. The lease release moved here for the same reason:
  left in `runAndPersist` it produced one write's worth of "no claim, no terminal entry",
  and a tail that lands in that window reports a finished run as lost.
- **The log is written only after the reader leaves.** While someone is attached they see
  every frame, so writing them down as well would cost a database write every half-second
  of every run to serve the few that get abandoned. `teeToRunLog` buffers instead and
  flushes the whole run so far the moment the connection drops. What it costs: while a
  window is attached the log is empty, so a *second* window watching the same run has
  nothing to show — `replayRunLog` says so after five seconds rather than looking stalled.
  Frames are still *serialised* as they arrive, on every run, because that is what keeps a
  generated image's megabytes out of the buffer rather than held for a reader who is
  probably still there. A flush that fails is logged and dropped, and its sequence numbers
  are spent — which is why `replayRunLog` checks for a gap on every read and not just the
  first: that hole lands in the middle. Replay drains the log in bounded sequence pages and
  only enters the polling delay after a short page.
  Image bytes never go in the log (a note goes in their place); the picture arrives with
  the persisted message, or — with no object storage configured — not at all, which the
  note says.
- **Version resolution**: `resolveVersion` asks the version repo for `"published"`
  (the port resolves the pointer) and falls back to the newest version by `createdAt`.
- **Persistence is flattened, but tool traffic is replayed.** After a run, `runAndPersist`
  writes tool results (`EngineChunk.toolResult` → `{ toolCallId, toolName, content }`) as
  `tool` messages followed by ONE `assistant` message holding the accumulated visible text,
  **the run's top-level `delta.toolCalls`** and any `warning` chunks it saw. Per-turn
  assistant messages are still not reconstructed — every turn's calls hang off the single
  flattened assistant message.
  - **`toolCalls` is stored unbudgeted**, unlike `content` and `reasoning` — nothing truncates
    it onto the message's byte budget (`MAX_PERSISTED_CONTENT_BYTES` in `run.ts`, this app's
    own number: one message row is replayed whole on every later turn), and a write that fails
    is caught and logged, taking the reply the reader just watched stream. What arrives here is already bounded: the engine swaps any
    argument past `MAX_TOOL_ARG_BYTES` for its size before the call is announced, keyed to
    size rather than to a tool name — see `src/application/llm/AGENTS.md`. Do not add a
    truncation here instead; cutting a call at this end would put arguments the model never
    made into the replay.
  - Only **top-level calls** are stored on the assistant message (`isTopLevelChunk`). A
    subagent's *results* are stored, because reading a finished chat has to show which
    agent, skill and tool produced the answer — but tagged with their `author` and
    `displayOnly`, so replay refuses them: the matching calls belong to the child's
    conversation, and a child's synthesized id can collide with the parent's.
  - A **successful transfer** emits a `displayOnly` result naming the target agent. It used
    to emit nothing at all (only failures did), so a finished conversation could not say
    which agent had answered. It is never replayed: the child's answer returns as its own
    message, so this marker in its place would say the delegation came back empty.
  - `toEngineMessages` pairs each stored `tool` row with the call that declared it and emits
    it *after* that assistant message — storage order within a turn is `tool… → assistant`,
    the reverse of what the wire format accepts. Pairing is scoped to one **run** (the
    messages a user turn delimits) and matches in order, because a tool-call id is only
    unique within the run that produced it: the engine synthesizes ids for providers that
    omit them, and the counter restarts each run. A chat-wide id map would let a later run's
    result answer an earlier run's call. A call with no stored result (a transfer's, which
    persists none) is dropped rather than left as an orphan the provider rejects, and a row
    with no matching call stays display-only.
  - Replay is bounded twice: the last `toolReplayTurns` assistant turns (default 3) and
    `MAX_REPLAYED_TOOL_CHARS` of text spent newest-first, truncating with a marker. Tool
    output is the bulkiest thing in a chat; unbounded replay would crowd out the conversation.
- **History is bounded, and says when it was.** A chat is stored in full and grows without
  limit, so replaying all of it first costs a resend of the whole conversation every turn and
  then fails outright once the provider's context limit is passed. `toEngineMessages` keeps
  the newest whole runs within `MAX_HISTORY_CHARS`/`MAX_HISTORY_MESSAGES` (the newest run
  always survives, even alone over budget) and returns `warnings` describing what it left
  out. `sendMessage` prepends those through `withLeadingWarnings`, so a trimmed context
  reaches the reader on the same channel an unusable binding does — never silently.
- **Images reach the message as keys, from two different directions.** A picture the *run*
  made is already stored by the time this surface sees it — the run bracket keeps what a run
  produces, which is what finally covered the builtins, an image subagent and an MCP tool's
  image, none of which this surface ever uploaded — so `collectGeneratedImages` only maps the
  key onto the message. A picture the *user attached* has no run behind it, so
  `storeAttachedImages` writes it through `storeArtifact` (`ChatDeps.artifacts`, wired when
  `S3_BUCKET_NAME` is set); before that it went to the same bucket with no row at all, which
  made attachments the one class of stored object nothing could list or delete. Either way the
  message keeps `images: [{ key, prompt? }]` — the b64 payload would be megabytes replayed on
  every later turn, far past the message's byte budget. The view signs each key with its own
  lifetime (`@/application/artifact/urlTtl`). A run
  instead reads the newest four stored images back under `MAX_IMAGE_BYTES` and sends them
  as data URLs, which is what registers both user attachments and assistant-produced images as
  editable handles; older images stay visible in the chat but are omitted from model context.
  Rows written before keys existed carry a public `url` used by the view only. A read or type
  failure is warned; an image that cannot be restored is dropped, never the message, and is
  reported too. With no object storage
  configured, images render during the live stream only, which is reported.
- **Files a run produced are references from the moment they arrive.** `EngineChunk.file` is
  a separate axis from `image` because everything that reads `image` *draws* it, and the run
  bracket has already stored the bytes and stripped them by the time this surface sees the
  chunk. So `collectGeneratedFiles` maps the reference onto the assistant message as
  `files: [{ key, name, mimeType, byteSize? }]`, `resolveFiles.ts` signs it per read, and the
  address carries the **filename to save as** — the object key is a UUID, and a browser handed
  one saves `c74d33ff-….pdf`. Three consequences. **Only the view resolves them**: a file's
  bytes never enter the model's context, so the replay path restores images and deliberately not
  these. **A file counts toward the turn being worth persisting** — a run whose only output was
  a document must retain a message or the stored object is unreachable from the conversation
  that made it. And the unstored case reads differently from an image's:
  an image that failed to store was still *seen*, while a file that failed has been nowhere, so
  the warning says the download does not exist rather than that it is temporary.
  A live frame carries no address (`LiveFile`) — signing one into every frame would put a
  credential on the wire for a link most readers never click, and the finished turn is seconds
  away and carries one.
- **Attachments are sent twice over, deliberately.** The turn being run carries the
  attachment *bytes* as inline `data:` content parts (`userTurnContent`) — that is what
  gives the engine a handle it can edit. Replayed history restores at most the newest four
  stored objects to the same inline shape. Older, legacy-URL, or unreadable images are omitted
  and reported; no provider receives a remote URL to fetch. A turn with attachments and no text
  is a content-parts message with no text part, never an empty user turn — and when none of its
  images can be addressed any more,
  `userMessage` substitutes a marker saying so, because an empty user turn is a shape some
  providers refuse outright.
- **Documents are stored as their text, not as the file.** `readMessageDocuments` reads the
  bytes exactly once; what comes back is both what this turn sends and what is persisted as
  `documents: [{ name, text, note? }]`. Storing the text is what lets the *next* question
  still have the document — a turn that only sent it would answer "summarise this" and then
  fail "what does section 3 say?" — and the bytes could not be stored anyway. Both the live
  turn and the replay wrap it with `framedDocument`, so a replayed turn is the one the chat
  recorded rather than a differently-shaped one.
- **Document text counts against the history budget** (`messageChars`). It sits beside
  `content` rather than in it, so measuring `content` alone would price a turn carrying
  40,000 characters of PDF as the sentence the user typed.
- **A run's termination persists as its warning, not as a field.** The turn guard announces
  itself twice — a `warning` naming the limit and a `finishReason` chunk (see
  `chunkTermination` in `src/domain/llm/types.ts`) — and the chat keeps only the warning,
  on the assistant message like every other one. The `finishReason` chunk is stream
  protocol: replay reconstructs nothing from it, because why a finished run ended is for
  the reader, not context for the next turn.
- **Subagent chunks** (`author` set) stream to the client but are excluded from the
  persisted assistant content, tool calls and tool rows alike.
- **Reasoning is shown and never replayed.** `AssistantChatMessage.reasoning` keeps the
  top-level run's thinking when the version opted in (`parameters.reasoningTrace`), flattened
  with the answer's own `TURN_SEPARATOR`. Four things about it:
  - It is **charged after the answer, out of the same item budget** — `MAX_PERSISTED_REASONING_BYTES`
    capped by what `MAX_PERSISTED_CONTENT_BYTES` has left. Two 350KB fields is a 700KB item,
    which the transactional write refuses whole; `persist()` logs rather than throws, so the
    reply the reader just watched stream would vanish on reload with only orphan tool rows
    behind it. Overflow reports itself with the same inline `…[truncated]` marker `content`
    uses — no extra warning, because a yellow banner on every long think is how that channel
    stops meaning anything.
  - It is **not replayed** by `toEngineMessages`. A run writes one assistant message holding
    every turn's text, so a `reasoning_content` on it would claim one block of thinking
    belonged to a message whose `tool_calls` came from several turns. It is also uncounted by
    `messageChars`, so replaying it would overrun the window without the "earlier turn(s)
    were left out" warning ever firing. `displayOnly` tool rows are refused for the same reason.
  - **`fromMessageItem` reads it by name.** The write spreads the whole message; a field
    missing from the read stores fine, type-checks fine, and comes back `undefined`.
    `tests/repositoryRoundTrip.test.ts` is the only test that catches it.
  - **The run log substitutes it.** Reasoning streams a token at a time, and each frame pays
    ~33 bytes of envelope; kept verbatim, a deep-thinking run fills the 350KB buffer and
    evicts the front of the *answer*, which the saved message holds in full. One note goes in
    instead, and the thinking arrives with the message the run writes on its way out. The
    substitution is written as "carries nothing else", so an axis added later fails closed.
- **`ChatDeps.runAgent` is lazy**: `createChat`/`sendMessage` do their writes and return
  a generator; the LLM call only starts when the route's `sseResponse` iterates it.
- **The head frame beats the run.** `withRunFrames` and `withReplayFrames` both answer
  with the head frame before pulling anything: `sseResponse` builds the `Response` around
  the first value it sees, so until then there are no headers, no keepalive and no chat id
  on the wire — and a run whose first token is a minute out (a reasoning prefill, a heavy
  document turn) would be cut by the ALB's 60s idle timeout having sent *nothing*, leaving
  the client with no run to reattach to or stop. The price is the refusal path: a run
  turned away — over its daily cost limit, out of slots — throws on the engine generator's
  first `next()`, which now lands on a response already committed to
  `200 text/event-stream`, so the chat routes deliver it as the SSE `{error}` frame rather
  than a 429 with a `Retry-After`. The chat client reads both shapes as the run's error;
  the agent API routes, whose callers do read statuses, still refuse before committing via
  `sseResponse`'s own first pull. `withLeadingWarnings` keeps pulling the source before
  emitting a warning, so a refused run fails before anything claims to speak for it.
- **Envelope frames**: both run streams open with a head frame naming the run
  (`{ chat?, runId, userSeq }` — the chat id on a new chat, the run id for reattaching or
  stopping it, and where the user's turn landed so a reader arriving mid-run does not draw
  it twice) and close with `{ ended: true }`. The trailing one exists because a closed body
  says nothing about *why* it closed: a client that cannot tell a finished run from a cut
  connection either reconnects to nothing or reports a truncated run as an answer.
- **Ownership**: reads and mutations alike treat a non-owner as 404 — a chat is private
  to its owner, and a 403 would confirm the chatId exists (docs/API.md).

## Cross-domain contracts

`executeAgent` (`@/application/execution/runProject`), `executionDeps` (`@/lib/container`),
and the project/version/usage repositories are owned by other domains; `run.ts` and
`deps.ts` are typed against `EngineChunk` / `ChatMessageInput` from `@/domain/llm/types`.
The client SSE reducer (`app/chats/_lib/stream.ts`) reads chunk fields structurally on
purpose — it parses raw SSE JSON, not typed values.
