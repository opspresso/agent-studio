import { parseWireToolCall } from "@/app/_lib/toolCalls";
import { removeActivePath, trackActivePath } from "@/app/_lib/authorPaths";
import { chunkAuthorPath, collectedWarning, isTopLevelChunk } from "@/domain/llm/types";
import type { LiveTurn, StreamChunk } from "./types";

/** Render a tool result payload to a readable string for a collapsible block. */
export function stringifyToolResult(toolResult: unknown): string {
  if (toolResult && typeof toolResult === "object") {
    const record = toolResult as Record<string, unknown>;
    const raw = record.content ?? record.result ?? toolResult;
    return typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
  }
  return typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult, null, 2);
}

function toolResultField(toolResult: unknown, field: string): string | undefined {
  if (toolResult && typeof toolResult === "object" && field in toolResult) {
    const value = (toolResult as Record<string, unknown>)[field];
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

/**
 * Fold one stream chunk into the live assistant turn. Subagent-authored content
 * (chunk carries `author`) is not merged into the visible answer but its label is
 * surfaced as a badge — mirroring what the server persists. Tool calls, tool
 * results, and generated images all render live regardless of author.
 */
export function reduceChunk(prev: LiveTurn, chunk: StreamChunk): LiveTurn {
  let { text, reasoning, reasoningTokens, toolCalls, tools, images, files, warnings, authorPaths } =
    prev;
  // Follow the stream: an authored chunk names a chain that is running now and
  // joins the set — several children speak at once under SDK delegation, while
  // a chain it is nested with has evidently finished. An unauthored chunk means
  // the top-level agent has control again, and none of them is still running.
  const path = chunkAuthorPath(chunk);
  authorPaths =
    path && chunk.authorDone
      ? removeActivePath(authorPaths, path)
      : path
        ? trackActivePath(authorPaths, path)
        : [];
  if (typeof chunk.delta?.content === "string" && isTopLevelChunk(chunk)) {
    text += chunk.delta.content;
  }
  // Top-level only, for the reason the answer is: several children thinking at
  // once interleave here with nothing saying whose thought is whose.
  if (typeof chunk.delta?.reasoningContent === "string" && isTopLevelChunk(chunk)) {
    reasoning += chunk.delta.reasoningContent;
  }
  // One usage chunk per turn, so an agent run's turns add up. Top-level only:
  // a child's spend is its own run's, and the panel here shows this run's.
  if (chunk.usage?.reasoningTokens !== undefined && isTopLevelChunk(chunk)) {
    reasoningTokens += chunk.usage.reasoningTokens;
  }
  if (Array.isArray(chunk.delta?.toolCalls)) {
    toolCalls = [...toolCalls, ...chunk.delta.toolCalls.map((call) => ({
      ...parseWireToolCall(call),
      author: chunk.author,
      authorPath: chunk.authorPath,
      transferId: chunk.transferId,
    }))];
  }
  if (chunk.toolResult !== undefined) {
    tools = [
      ...tools,
      {
        // Carried so the result can be put back beside the call that asked for
        // it — the id is scoped to the delegation that produced this chunk.
        id: toolResultField(chunk.toolResult, "toolCallId"),
        name: toolResultField(chunk.toolResult, "name"),
        content: stringifyToolResult(chunk.toolResult),
        author: chunk.author,
        authorPath: chunk.authorPath,
        transferId: chunk.transferId,
      },
    ];
  }
  if (chunk.image) {
    images = [...images, chunk.image];
  }
  if (chunk.file) {
    files = [
      ...files,
      {
        name: chunk.file.name,
        mimeType: chunk.file.mimeType,
        ...(chunk.file.byteSize !== undefined ? { byteSize: chunk.file.byteSize } : {}),
        ...(chunk.file.artifactId ? { artifactId: chunk.file.artifactId } : {}),
      },
    ];
  }
  const warning = collectedWarning(chunk, warnings);
  if (warning !== undefined) {
    warnings = [...warnings, warning];
  }
  return {
    text,
    reasoning,
    reasoningTokens,
    toolCalls,
    tools,
    images,
    files,
    warnings,
    authorPaths,
  };
}
