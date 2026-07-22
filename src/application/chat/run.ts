import type { Project, Version } from "@/domain/project/types";
import type { Chat } from "@/domain/chat/types";
import type { EngineChunk } from "@/domain/llm/types";
import type { ChatDeps } from "./deps";

/** Resolve the published version, falling back to the latest version by createdAt. */
export async function resolveVersion(
  deps: ChatDeps,
  project: Project,
): Promise<Version | null> {
  const published = await deps.versions.get(project.name, "published");
  if (published) {
    return published;
  }
  const all = await deps.versions.list(project.name);
  if (all.length === 0) {
    return null;
  }
  return [...all].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[all.length - 1] ?? null;
}

/**
 * Tee an engine stream to the client while accumulating the assistant answer and
 * tool results, then persist them once the stream completes.
 *
 * Only non-subagent chunks (`author` absent) contribute to the persisted assistant
 * message; subagent chunks still reach the client for live rendering.
 *
 * Tool messages are persisted for UI/audit display only. They are intentionally
 * NOT replayed into engine context on the next turn: the assistant message is
 * stored without `tool_calls`, so `toEngineMessages` drops the orphaned tool rows
 * and the conversation continues from the final assistant text alone. Keep both
 * sides of this contract in sync (see the round-trip test in tests/chat.test.ts).
 */
export async function* runAndPersist(
  deps: ChatDeps,
  chat: Chat,
  source: AsyncGenerator<EngineChunk>,
  startSeq: number,
): AsyncGenerator<EngineChunk> {
  let content = "";
  const toolMessages: { content: string; toolCallId: string }[] = [];

  for await (const chunk of source) {
    const delta = chunk.delta?.content;
    if (typeof delta === "string" && !chunk.author) {
      content += delta;
    }
    if (chunk.toolResult) {
      toolMessages.push({
        content: chunk.toolResult.content,
        toolCallId: chunk.toolResult.toolCallId,
      });
    }
    yield chunk;
  }

  const now = new Date().toISOString();
  let seq = startSeq;
  for (const tool of toolMessages) {
    await deps.chats.appendMessage({
      chatId: chat.chatId,
      seq: seq++,
      role: "tool",
      content: tool.content,
      toolCallId: tool.toolCallId,
      createdAt: now,
    });
  }
  await deps.chats.appendMessage({
    chatId: chat.chatId,
    seq: seq++,
    role: "assistant",
    content,
    createdAt: now,
  });
  await deps.chats.put({ ...chat, updatedAt: now });
}
