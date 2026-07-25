import type { Project, Version } from "@/domain/project/types";
import { resolveRunnableVersion } from "@/application/project/resolveRunnableVersion";
import type { Chat, ChatMessageImage } from "@/domain/chat/types";
import { isTopLevelChunk } from "@/domain/llm/types";
import type { ContentPart, EngineChunk } from "@/domain/llm/types";
import type { AttachedImage, ChatDeps } from "./deps";

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
 * The engine body for a user turn. Attachments travel as inline data URLs, so
 * this turn works whether or not object storage is configured — and the engine
 * gets real bytes, which is what makes an attachment editable.
 */
export function userTurnContent(
  content: string,
  images: AttachedImage[],
): string | ContentPart[] {
  if (images.length === 0) {
    return content;
  }
  return [
    ...(content ? [{ type: "text" as const, text: content }] : []),
    ...images.map((image) => ({
      type: "image_url" as const,
      image_url: { url: `data:${image.mimeType};base64,${image.b64}` },
    })),
  ];
}

/**
 * Upload images for persistence and keep only their URLs — a b64 payload is far
 * beyond the DynamoDB item size limit. Without `storeImage` nothing is stored
 * (live rendering only); a failed upload drops that image, never the message.
 */
export async function storeMessageImages(
  deps: ChatDeps,
  images: Array<{ b64: string; mimeType: string; prompt?: string }>,
): Promise<ChatMessageImage[]> {
  const stored: ChatMessageImage[] = [];
  if (!deps.storeImage) {
    return stored;
  }
  for (const image of images) {
    try {
      const url = await deps.storeImage({ b64: image.b64, mimeType: image.mimeType });
      stored.push(image.prompt === undefined ? { url } : { url, prompt: image.prompt });
    } catch (error) {
      console.error("[chat] image upload failed", error);
    }
  }
  return stored;
}

/**
 * A single chat message is one DynamoDB item (400KB hard limit). Truncate on a
 * byte budget so one oversized tool result / answer can't fail the whole turn's
 * persistence and lose the reply the user already saw streamed.
 */
const MAX_PERSISTED_CONTENT_BYTES = 350_000;

function truncateForPersist(content: string): string {
  if (Buffer.byteLength(content, "utf8") <= MAX_PERSISTED_CONTENT_BYTES) {
    return content;
  }
  const marker = "\n…[truncated]";
  const budget = MAX_PERSISTED_CONTENT_BYTES - Buffer.byteLength(marker, "utf8");
  return Buffer.from(content, "utf8").subarray(0, budget).toString("utf8") + marker;
}

/**
 * Tee an engine stream to the client while accumulating the assistant answer and
 * tool results, then persist them.
 *
 * Only non-subagent chunks (`author` absent) contribute to the persisted assistant
 * message; subagent chunks still reach the client for live rendering.
 *
 * Persistence is best-effort and runs on every exit path — normal completion,
 * an engine error, and client disconnect (`generator.return()`) — so a dropped
 * connection persists what streamed instead of leaving a dangling user turn.
 * A persistence failure is logged, never thrown: throwing on the return path
 * would reject the SSE `cancel()`, and the client already saw the answer.
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
  runId?: string,
): AsyncGenerator<EngineChunk> {
  let content = "";
  const toolMessages: { content: string; toolCallId: string; toolName: string }[] = [];
  const generatedImages: { b64: string; mimeType: string; prompt?: string }[] = [];
  let persisted = false;

  async function persist(): Promise<void> {
    if (persisted) {
      return;
    }
    persisted = true;
    if (!content && toolMessages.length === 0 && generatedImages.length === 0) {
      return;
    }
    try {
      const images = await storeMessageImages(deps, generatedImages);

      const now = new Date().toISOString();
      for (const tool of toolMessages) {
        await deps.chats.appendMessage({
          chatId: chat.chatId,
          seq: await deps.chats.reserveMessageSeq(chat.chatId),
          role: "tool",
          content: truncateForPersist(tool.content),
          toolCallId: tool.toolCallId,
          toolName: tool.toolName,
          createdAt: now,
        });
      }
      await deps.chats.appendMessage({
        chatId: chat.chatId,
        seq: await deps.chats.reserveMessageSeq(chat.chatId),
        role: "assistant",
        content: truncateForPersist(content),
        ...(images.length > 0 ? { images } : {}),
        createdAt: now,
      });
      await deps.chats.update({ ...chat, updatedAt: now });
    } catch (error) {
      console.error("[chat] persist failed", error);
    }
  }

  try {
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
    await persist();
  } finally {
    // Covers client disconnect and engine errors — persist() is idempotent.
    await persist();
    if (runId) {
      await deps.chats.releaseRun(chat.chatId, runId);
    }
  }
}
