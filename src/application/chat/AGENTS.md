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
- **Persistence is flattened.** After a run, `runAndPersist` writes tool results
  (`EngineChunk.toolResult` → `{ toolCallId, toolName, content }`) as `tool` messages followed by
  ONE `assistant` message holding the accumulated visible text. We intentionally do NOT
  reconstruct per-turn assistant `tool_calls` even though the engine exposes
  `delta.toolCalls` — the task's persistence contract is "accumulated content + tool
  messages". Consequence: `toEngineMessages` drops `tool` messages that have no matching
  assistant `tool_calls` (all of them, currently), so replayed history is user +
  assistant turns; tool messages are kept only for UI display. To enable full tool replay
  later, accumulate `delta.toolCalls` onto the persisted assistant message — the mapper
  already pairs them by id.
- **Generated images** (`EngineChunk.image`) are uploaded through the optional
  `ChatDeps.storeImage` port (S3, wired when `S3_BUCKET_NAME` is set) and persisted as
  `images: [{ url, prompt? }]` on the assistant message — the b64 payload itself is far
  beyond the DynamoDB item size limit. A failed upload drops that image, never the
  message. Without `storeImage`, images render only during the live stream.
- **Subagent chunks** (`author` set) stream to the client but are excluded from the
  persisted assistant content.
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
