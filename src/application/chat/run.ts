import type {
  Chat,
  ChatMessageDocument,
  ChatMessageFile,
  ChatMessageImage,
} from "@/domain/chat/types";
import { imageDataUrl, isTopLevelChunk } from "@/domain/llm/types";
import type { ChannelToolCall, ContentPart, EngineChunk } from "@/domain/llm/types";
import {
  turnContent,
  type ReadDocument,
} from "@/application/llm/documentParts";
import type { AttachedDocumentInput, AttachedImage, ChatDeps } from "./deps";
import { storeArtifact, type ArtifactContext } from "@/application/artifact/storeArtifact";
import { filesNotKeptWarning } from "@/application/artifact/producedFiles";
import { endNoticeFor } from "./cancelRun";
import { log } from "@/shared/logger";
import { cutUtf8Bytes } from "@/shared/utf8Text";
import { prepareDocumentAttachments } from "@/application/document/attachments";

/**
 * The engine body for a user turn. Attachments travel as inline data URLs, so
 * this turn works whether or not object storage is configured — and the engine
 * gets real bytes, which is what makes an attachment editable.
 */
export function userTurnContent(
  content: string,
  images: AttachedImage[],
  documents: ReadDocument[] = [],
): string | ContentPart[] {
  return turnContent(
    documents,
    content,
    images.map((image) => ({
      type: "image_url" as const,
      image_url: { url: imageDataUrl(image) },
    })),
  );
}

/** Store original documents separately and keep bounded text on the chat message. */
export async function readMessageDocuments(
  deps: ChatDeps,
  context: ArtifactContext,
  documents: AttachedDocumentInput[],
): Promise<{ stored: ChatMessageDocument[]; warnings: string[] }> {
  return prepareDocumentAttachments(deps.documents, deps.artifacts, context, documents.map((document) => ({
    bytes: Buffer.from(document.b64, "base64"), mimeType: document.mimeType, name: document.name,
  })));
}

/**
 * Take the keys off images a run already stored.
 *
 * Nothing is uploaded here any more: the run bracket keeps what a run produces,
 * which is what finally covers the pictures this surface never made itself — the
 * builtins, an image subagent, an MCP tool that returned one. What is left is
 * mapping the reference onto the message, since the chat row keeps its own copy
 * of the key rather than a pointer to the artifact row (a message has to render
 * without a second read, and a replay needs the key inline).
 *
 * A drop is still reported rather than only logged: to the reader an image that
 * was never stored is indistinguishable from one that was never made. When
 * storage *is* configured the capture already warned about its own failure, so
 * saying it twice would be the noise, and only the unconfigured case speaks.
 */
export function collectGeneratedImages(
  images: Array<{ prompt?: string; key?: string }>,
  storageConfigured: boolean,
): { stored: ChatMessageImage[]; warnings: string[] } {
  const stored: ChatMessageImage[] = [];
  for (const image of images) {
    if (!image.key) {
      continue;
    }
    stored.push(image.prompt === undefined ? { key: image.key } : { key: image.key, prompt: image.prompt });
  }
  const missing = images.length - stored.length;
  if (missing > 0 && !storageConfigured) {
    return {
      stored,
      warnings: [
        `${missing} image(s) are shown for this turn only: image storage is not configured, so they are not kept with the chat.`,
      ],
    };
  }
  return { stored, warnings: [] };
}

/**
 * Take the references off files a run already stored.
 *
 * The sibling of {@link collectGeneratedImages}, with one asymmetry that decides
 * the wording. An image that failed to store was still *seen* — its bytes rode
 * the stream, so "shown for this turn only" is the truth. A file's bytes are
 * stripped at the bracket the moment it is stored, and a file that was not
 * stored has been nowhere at all: there is no copy on the connection to fall
 * back to, and the reader is being told the download does not exist rather than
 * that it is temporary.
 *
 * Only the unconfigured case speaks here. When storage *is* configured the
 * capture already warned, with the provider's reason attached — repeating it
 * would be the noise.
 */
export function collectGeneratedFiles(
  files: Array<{
    name: string;
    mimeType: string;
    byteSize?: number;
    key?: string;
    artifactId?: string;
  }>,
  storageConfigured: boolean,
): { stored: ChatMessageFile[]; warnings: string[] } {
  const stored: ChatMessageFile[] = [];
  for (const file of files) {
    if (!file.key) {
      continue;
    }
    stored.push({
      key: file.key,
      name: file.name,
      mimeType: file.mimeType,
      ...(file.byteSize !== undefined ? { byteSize: file.byteSize } : {}),
      ...(file.artifactId ? { artifactId: file.artifactId } : {}),
    });
  }
  const missing = files.length - stored.length;
  if (missing > 0 && !storageConfigured) {
    // The sentence is shared with every other surface that answers with a file:
    // an API caller, an A2A task and a Slack thread all reach the same state,
    // and six spellings of it is how one of them ends up saying something
    // subtly different about the same deployment.
    return { stored, warnings: [filesNotKeptWarning(missing)] };
  }
  return { stored, warnings: [] };
}

/**
 * Keep an image a person attached, and give the message its key.
 *
 * These get an artifact row like anything else. Before that they went to the
 * same bucket with no inventory at all, which made them the one class of stored
 * object nothing could ever list or delete — building a gallery with a delete
 * button while still producing those would be shipping the same hole twice.
 */
export async function storeAttachedImages(
  deps: ChatDeps,
  context: ArtifactContext,
  images: Array<{ b64: string; mimeType: string }>,
): Promise<{ stored: ChatMessageImage[]; warnings: string[] }> {
  const stored: ChatMessageImage[] = [];
  if (images.length === 0) {
    return { stored, warnings: [] };
  }
  if (!deps.artifacts) {
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
      const artifact = await storeArtifact(deps.artifacts, context, {
        kind: "image",
        source: "attachment",
        bytes: Buffer.from(image.b64, "base64"),
        mimeType: image.mimeType,
      });
      stored.push({ key: artifact.key });
    } catch (error) {
      failed += 1;
      reason = error instanceof Error ? error.message : String(error);
      log.error("chat", "image upload failed", error);
    }
  }
  const warnings =
    failed > 0
      ? [`${failed} image(s) could not be stored and will not survive a reload: ${reason}`]
      : [];
  return { stored, warnings };
}

/**
 * A single chat message is one row that every later turn replays. Truncate on a
 * byte budget so one oversized tool result / answer can't fail the whole turn's
 * persistence and lose the reply the user already saw streamed.
 */
const MAX_PERSISTED_CONTENT_BYTES = 350_000;

/**
 * How much of a run's thinking one message keeps.
 *
 * Charged *after* the answer and out of the same budget above, not beside it: a
 * reasoning model can think for as long as it speaks, and giving each its own
 * 350KB is how one item becomes 700KB and the whole turn's write fails —
 * silently, since `persist()` logs rather than throws, taking the reply the
 * reader just watched stream with it. The answer is what must survive, so it is
 * spent first and this is a ceiling on whatever is left.
 */
const MAX_PERSISTED_REASONING_BYTES = 40_000;

function truncateForPersist(content: string, budget = MAX_PERSISTED_CONTENT_BYTES): string {
  if (Buffer.byteLength(content, "utf8") <= budget) {
    return content;
  }
  const marker = "\n…[truncated]";
  const room = budget - Buffer.byteLength(marker, "utf8");
  if (room <= 0) {
    // Nothing fits, not even the marker. Returning the marker alone would put
    // a field on the item whose whole content is the word "[truncated]" — and
    // one that costs the 15 bytes the shared budget was sized to the byte to
    // avoid. Empty is the honest answer and, being falsy, keeps the field off.
    return "";
  }
  // Byte-boundary-safe: a bare subarray cut would persist U+FFFD where the
  // budget fell inside a multi-byte character.
  return cutUtf8Bytes(content, room) + marker;
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
 * an engine error, and a consumer that stopped early (`generator.return()`) — so
 * an interrupted run persists what streamed instead of leaving a dangling user
 * turn. A persistence failure is logged, never thrown: throwing on the return
 * path would reject the SSE `cancel()`, and the client already saw the answer.
 *
 * The run lease is **not** released here. `teeToRunLog` wraps this and owns the
 * release, so the terminal log entry lands between the two — see the ordering
 * this file's caller depends on in `runLog.ts`.
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
  /** The run's own signal, so an abort this surface asked for is not a failure. */
  signal?: AbortSignal,
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
  // The reference, never the bytes — for both of these, and for the same
  // reason. The chunk carrying an image keeps its base64 all the way to the
  // reader, because that is what draws it live; a file keeps its own whenever
  // no object storage is configured to strip it. Either payload pushed onto
  // these arrays is then held for the whole run by a surface that reads nothing
  // but the key when it persists — a run that draws twenty pictures is twenty
  // pictures of heap per chat in flight, for no reader at all.
  const generatedImages: { prompt?: string; key?: string }[] = [];
  const generatedFiles: {
    name: string;
    mimeType: string;
    byteSize?: number;
    key?: string;
    artifactId?: string;
  }[] = [];
  // Why the run came out the shape it did — a binding it could not use, history
  // it could not carry. Persisted so reloading the chat still explains it.
  const warnings: string[] = [];
  // The top-level run's own thinking, when the Agent asked for it to be kept.
  // Subagent reasoning is dropped for the reason its content is: four children
  // dispatched at once interleave on the wire with nothing saying whose is whose.
  let reasoning = "";
  let reasoningTokens = 0;
  let persisted = false;

  /** Kept to one per distinct reason, and bounded: the message is one item. */
  function note(warning: string): void {
    if (warnings.length < MAX_PERSISTED_WARNINGS && !warnings.includes(warning)) {
      warnings.push(warning);
    }
  }

  async function persist(): Promise<void> {
    if (persisted) {
      return;
    }
    persisted = true;
    if (
      !content &&
      !reasoning &&
      toolMessages.length === 0 &&
      toolCalls.length === 0 &&
      generatedImages.length === 0 &&
      generatedFiles.length === 0 &&
      warnings.length === 0
    ) {
      return;
    }
    try {
      const uploaded = collectGeneratedImages(generatedImages, deps.artifacts !== undefined);
      const images = uploaded.stored;
      const produced = collectGeneratedFiles(generatedFiles, deps.artifacts !== undefined);
      const files = produced.stored;
      for (const warning of [...uploaded.warnings, ...produced.warnings]) {
        // Too late to stream — the run is over — but it survives on the message,
        // which is exactly where a reader wonders where the picture went.
        note(warning);
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
      const persistedContent = truncateForPersist(content);
      const persistedReasoning = truncateForPersist(
        reasoning,
        Math.min(
          MAX_PERSISTED_REASONING_BYTES,
          MAX_PERSISTED_CONTENT_BYTES - Buffer.byteLength(persistedContent, "utf8"),
        ),
      );
      // The answer filled the item on its own. Said, because the alternative is
      // a message carrying a thinking-token count and no thinking, which the
      // view can only read as the provider having withheld the text — the
      // opposite of what happened, and a claim about the model rather than
      // about this message's budget.
      const reasoningDropped = reasoning !== "" && persistedReasoning === "";
      if (reasoningDropped) {
        note("This run's reasoning was not kept: the answer filled the message on its own.");
      }
      await deps.chats.appendMessage({
        chatId: chat.chatId,
        seq: await deps.chats.reserveMessageSeq(chat.chatId),
        role: "assistant",
        content: persistedContent,
        ...(persistedReasoning ? { reasoning: persistedReasoning } : {}),
        // Only ever beside the text it counts. `toUsageInfo` reports whatever
        // the provider says — the *yield* is what `reasoningTrace` gates — so a
        // count stored on its own would land on every turn of every Agent
        // that never opted in, where nothing renders it. A provider that
        // reports the size and withholds the thinking is the engine's warning
        // to give, not a number for this message to carry alone.
        ...(persistedReasoning && reasoningTokens > 0 ? { reasoningTokens } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(images.length > 0 ? { images } : {}),
        ...(files.length > 0 ? { files } : {}),
        createdAt: now,
      });
      await deps.chats.update({ ...chat, updatedAt: now });
    } catch (error) {
      log.error("chat", "persist failed", error);
    }
  }

  try {
    for await (const chunk of source) {
      const delta = chunk.delta?.content;
      if (typeof delta === "string" && isTopLevelChunk(chunk)) {
        content += delta;
      }
      if (chunk.usage?.reasoningTokens !== undefined && isTopLevelChunk(chunk)) {
        reasoningTokens += chunk.usage.reasoningTokens;
      }
      const reasoningDelta = chunk.delta?.reasoningContent;
      if (typeof reasoningDelta === "string" && isTopLevelChunk(chunk)) {
        // Restored text, the same source `content` takes: the masked copy is the
        // engine's own, and storing it would put `[[PII:…]]` beside a plain answer.
        reasoning += reasoningDelta;
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
      if (chunk.warning) {
        note(chunk.warning);
      }
      if (chunk.image) {
        generatedImages.push({
          ...(chunk.image.prompt !== undefined ? { prompt: chunk.image.prompt } : {}),
          ...(chunk.image.key !== undefined ? { key: chunk.image.key } : {}),
        });
      }
      if (chunk.file) {
        generatedFiles.push({
          name: chunk.file.name,
          mimeType: chunk.file.mimeType,
          ...(chunk.file.byteSize !== undefined ? { byteSize: chunk.file.byteSize } : {}),
          ...(chunk.file.key !== undefined ? { key: chunk.file.key } : {}),
          ...(chunk.file.artifactId !== undefined ? { artifactId: chunk.file.artifactId } : {}),
        });
      }
      yield chunk;
    }
    await persist();
  } catch (thrown) {
    // An abort this surface asked for is not a failure, and the engine cannot
    // say which it was — it rethrows whichever one it was given, so the intent
    // survives on the signal instead.
    //
    // The note is handled here rather than outside because this is the only
    // place that can *persist* it. Wrapped around this generator, a stop reached
    // the reader and no further: the assistant message was already written by
    // the time the abort surfaced, so reloading the chat showed a reply stopping
    // mid-sentence with nothing to say why.
    const notice = endNoticeFor(signal);
    if (notice === undefined) {
      throw thrown;
    }
    note(notice);
    yield { warning: notice };
  } finally {
    // Covers an early return and engine errors — persist() is idempotent.
    await persist();
  }
}
