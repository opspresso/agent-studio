import type { Project, Version } from "@/domain/project/types";
import { resolveRunnableVersion } from "@/application/project/resolveRunnableVersion";
import type { Chat, ChatMessageImage } from "@/domain/chat/types";
import { imageDataUrl, isTopLevelChunk } from "@/domain/llm/types";
import type { ChannelToolCall, ContentPart, EngineChunk } from "@/domain/llm/types";
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
      image_url: { url: imageDataUrl(image) },
    })),
  ];
}

/**
 * Upload images for persistence and keep only their URLs — a b64 payload is far
 * beyond the DynamoDB item size limit. Without `storeImage` nothing is stored
 * (live rendering only); a failed upload drops that image, never the message.
 *
 * A drop is reported rather than only logged: to the reader an image that was
 * never stored is indistinguishable from one that was never made, and the run
 * looks like it ignored the request. The warnings ride the same channel an
 * unusable binding does, so they reach the live view and the stored message.
 */
export async function storeMessageImages(
  deps: ChatDeps,
  images: Array<{ b64: string; mimeType: string; prompt?: string }>,
): Promise<{ stored: ChatMessageImage[]; warnings: string[] }> {
  const stored: ChatMessageImage[] = [];
  const warnings: string[] = [];
  if (images.length === 0) {
    return { stored, warnings };
  }
  if (!deps.storeImage) {
    return {
      stored,
      warnings: [
        `${images.length} image(s) are shown for this turn only: image storage is not configured, so they are not kept with the chat.`,
      ],
    };
  }
  let failed = 0;
  let reason = "";
  for (const image of images) {
    try {
      const url = await deps.storeImage({ b64: image.b64, mimeType: image.mimeType });
      stored.push(image.prompt === undefined ? { url } : { url, prompt: image.prompt });
    } catch (error) {
      failed += 1;
      reason = error instanceof Error ? error.message : String(error);
      console.error("[chat] image upload failed", error);
    }
  }
  if (failed > 0) {
    warnings.push(`${failed} image(s) could not be stored and will not survive a reload: ${reason}`);
  }
  return { stored, warnings };
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
 * Warnings the mapping layer produced, ahead of the engine's own. They ride the
 * same chunk channel so every consumer — live UI, Slack, persistence — handles
 * one kind of warning, and `yield*` still forwards a client disconnect to the
 * run underneath.
 */
export async function* withLeadingWarnings(
  warnings: string[],
  source: AsyncGenerator<EngineChunk>,
): AsyncGenerator<EngineChunk> {
  for (const warning of warnings) {
    yield { warning };
  }
  yield* source;
}

/** A run reports one warning per unusable binding; the item stays bounded. */
const MAX_PERSISTED_WARNINGS = 20;

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
 * The turn's top-level tool calls AND their results are stored, which is what
 * lets `toEngineMessages` pair them and replay the recent ones — without it a
 * follow-up question reaches a model that cannot see what the tools returned and
 * calls them again. Keep both sides of this contract in sync (see the round-trip
 * test in tests/chat.test.ts).
 *
 * A subagent's results are stored too, but as `displayOnly` rows carrying the
 * author: reading a chat means seeing which agent, skill and tool produced the
 * answer, while replay must still refuse them — the matching calls belong to the
 * child's conversation, so a replayed row would claim a result this turn never
 * declared. Only the top-level calls are stored on the assistant message.
 */
export async function* runAndPersist(
  deps: ChatDeps,
  chat: Chat,
  source: AsyncGenerator<EngineChunk>,
  runId?: string,
): AsyncGenerator<EngineChunk> {
  let content = "";
  const toolMessages: {
    content: string;
    toolCallId: string;
    toolName: string;
    author?: string;
    displayOnly?: boolean;
  }[] = [];
  // Only the top-level run's calls: a subagent's belong to its own conversation,
  // and hanging them off this assistant message would claim results this turn
  // never produced.
  const toolCalls: ChannelToolCall[] = [];
  const generatedImages: { b64: string; mimeType: string; prompt?: string }[] = [];
  // Why the run came out the shape it did — a binding it could not use, history
  // it could not carry. Persisted so reloading the chat still explains it.
  const warnings: string[] = [];
  let persisted = false;

  async function persist(): Promise<void> {
    if (persisted) {
      return;
    }
    persisted = true;
    if (
      !content &&
      toolMessages.length === 0 &&
      generatedImages.length === 0 &&
      warnings.length === 0
    ) {
      return;
    }
    try {
      const uploaded = await storeMessageImages(deps, generatedImages);
      const images = uploaded.stored;
      for (const warning of uploaded.warnings) {
        // Too late to stream — the run is over — but it survives on the message,
        // which is exactly where a reader wonders where the picture went.
        if (warnings.length < MAX_PERSISTED_WARNINGS && !warnings.includes(warning)) {
          warnings.push(warning);
        }
      }

      const now = new Date().toISOString();
      for (const tool of toolMessages) {
        await deps.chats.appendMessage({
          chatId: chat.chatId,
          seq: await deps.chats.reserveMessageSeq(chat.chatId),
          role: "tool",
          content: truncateForPersist(tool.content),
          toolCallId: tool.toolCallId,
          toolName: tool.toolName,
          ...(tool.author ? { author: tool.author } : {}),
          ...(tool.displayOnly ? { displayOnly: true } : {}),
          createdAt: now,
        });
      }
      await deps.chats.appendMessage({
        chatId: chat.chatId,
        seq: await deps.chats.reserveMessageSeq(chat.chatId),
        role: "assistant",
        content: truncateForPersist(content),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
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
      if (chunk.delta?.toolCalls && isTopLevelChunk(chunk)) {
        toolCalls.push(...chunk.delta.toolCalls);
      }
      if (chunk.toolResult) {
        // A subagent's row, and a transfer's marker, are kept for the reader but
        // never replayed — see `toEngineMessages`.
        const displayOnly = !isTopLevelChunk(chunk) || chunk.toolResult.displayOnly === true;
        toolMessages.push({
          content: chunk.toolResult.content,
          toolCallId: chunk.toolResult.toolCallId,
          toolName: chunk.toolResult.name,
          ...(chunk.author ? { author: chunk.author } : {}),
          ...(displayOnly ? { displayOnly: true } : {}),
        });
      }
      if (
        chunk.warning &&
        warnings.length < MAX_PERSISTED_WARNINGS &&
        !warnings.includes(chunk.warning)
      ) {
        warnings.push(chunk.warning);
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
