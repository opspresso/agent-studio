import type { Project, Version } from "@/domain/project/types";
import { resolveRunnableVersion } from "@/application/project/resolveRunnableVersion";
import type { Chat, ChatMessageImage } from "@/domain/chat/types";
import { isTopLevelChunk } from "@/domain/llm/types";
import type { EngineChunk } from "@/domain/llm/types";
import type { ChatDeps } from "./deps";

/**
 * Chat is an interactive surface, so it may fall back to the newest draft
 * when nothing is published (see resolveRunnableVersion for the policy).
 */
export async function resolveVersion(
  deps: ChatDeps,
  project: Project,
): Promise<Version | null> {
  return resolveRunnableVersion(deps.versions, project, { allowDraftFallback: true });
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
  const toolMessages: { content: string; toolCallId: string; toolName: string }[] = [];
  const generatedImages: { b64: string; mimeType: string; prompt?: string }[] = [];

  for await (const chunk of source) {
    const delta = chunk.delta?.content;
    if (typeof delta === "string" && isTopLevelChunk(chunk)) {
      content += delta;
    }
    if (chunk.toolResult) {
      toolMessages.push({
        content: chunk.toolResult.content,
        toolCallId: chunk.toolResult.toolCallId,
        toolName: chunk.toolResult.name,
      });
    }
    if (chunk.image) {
      generatedImages.push(chunk.image);
    }
    yield chunk;
  }

  // Upload images to object storage and keep only the URLs — the b64 payloads
  // are far beyond the DynamoDB item size limit. A failed upload drops that
  // image but never the message.
  const images: ChatMessageImage[] = [];
  if (deps.storeImage) {
    for (const image of generatedImages) {
      try {
        const url = await deps.storeImage({ b64: image.b64, mimeType: image.mimeType });
        images.push(image.prompt === undefined ? { url } : { url, prompt: image.prompt });
      } catch (error) {
        console.error("[chat] image upload failed", error);
      }
    }
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
      toolName: tool.toolName,
      createdAt: now,
    });
  }
  await deps.chats.appendMessage({
    chatId: chat.chatId,
    seq: seq++,
    role: "assistant",
    content,
    ...(images.length > 0 ? { images } : {}),
    createdAt: now,
  });
  await deps.chats.put({ ...chat, updatedAt: now });
}
