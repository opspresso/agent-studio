# Chat Application Use Cases

Use cases for agent-backed chats. Pure orchestration over injected ports (`ChatDeps`);
no AWS/framework imports. Wiring to concrete adapters happens at the route boundary
(`src/app/api/chats/_deps.ts`), which also binds `executeAgent(executionDeps, params)`
into `ChatDeps.runAgent`.

## Files

- `deps.ts` — `ChatDeps` port bag + `AgentRunner` (bound engine call).
- `errors.ts` — `ChatError` subclasses carry the HTTP status the route surfaces.
- `title.ts` — first-message → title, truncated to 50 chars.
- `messageMapping.ts` — stored `ChatMessage[]` → OpenAI-shaped engine messages.
- `run.ts` — `resolveVersion` (published → latest fallback) and `runAndPersist`
  (tee the engine stream to the client, persist afterward).
- `createChat.ts` / `sendMessage.ts` / `listChats.ts` / `getChat.ts` / `deleteChat.ts`.

## Design decisions (read before changing)

- **Version resolution**: `resolveVersion` asks the version repo for `"published"`
  (the port resolves the pointer) and falls back to the newest version by `createdAt`.
- **Persistence is flattened, but tool traffic is replayed.** After a run, `runAndPersist`
  writes tool results (`EngineChunk.toolResult` → `{ toolCallId, toolName, content }`) as
  `tool` messages followed by ONE `assistant` message holding the accumulated visible text,
  **the run's top-level `delta.toolCalls`** and any `warning` chunks it saw. Per-turn
  assistant messages are still not reconstructed — every turn's calls hang off the single
  flattened assistant message.
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
- **Images** (generated `EngineChunk.image`, and the user's attachments) are uploaded
  through the optional `ChatDeps.storeImage` port (S3, wired when `S3_BUCKET_NAME` is set)
  by `storeMessageImages` and persisted as `images: [{ url, prompt? }]` on the message —
  the b64 payload itself is far beyond the DynamoDB item size limit. A failed upload drops
  that image, never the message — and says so through the warning channel, because an image
  that was never stored is indistinguishable from one that was never made. Without
  `storeImage`, images render only during the live stream, which is also reported.
- **Attachments are sent twice over, deliberately.** The turn being run carries the
  attachment *bytes* as inline `data:` content parts (`userTurnContent`) — that is what
  gives the engine a handle it can edit. Replayed history carries the *stored URL*
  (`toEngineMessages`), which the provider fetches: visible to the model, not editable.
  A turn with attachments and no text is a content-parts message with no text part, never
  an empty user turn.
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
- **Subagent chunks** (`author` set) stream to the client but are excluded from the
  persisted assistant content, tool calls and tool rows alike.
- **`ChatDeps.runAgent` is lazy**: `createChat`/`sendMessage` do their writes and return
  a generator; the LLM call only starts when the route's `sseResponse` iterates it.
- **chatId delivery**: `POST /api/chats` streams SSE, so the route prepends a
  `{ chat }` envelope frame before the engine chunks so the client learns the id.
- **Ownership**: reads (`getChat`) treat non-owner as 404; mutations (`sendMessage`,
  `deleteChat`) return 403 on owner mismatch, 404 when missing.

## Cross-domain contracts

`executeAgent` (`@/application/execution/runProject`), `executionDeps` (`@/lib/container`),
and the project/version/usage repositories are owned by other domains; `run.ts` and
`deps.ts` are typed against `EngineChunk` / `ChatMessageInput` from `@/domain/llm/types`.
The client SSE reducer (`app/chats/_lib/stream.ts`) reads chunk fields structurally on
purpose — it parses raw SSE JSON, not typed values.
