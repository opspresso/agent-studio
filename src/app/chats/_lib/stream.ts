import { parseWireToolCall } from "@/app/_lib/toolCalls";
import { chunkAuthorPath, trackActivePath } from "@/app/_lib/authorPaths";
import { isTopLevelChunk } from "@/domain/llm/types";
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

function toolResultName(toolResult: unknown): string | undefined {
  if (toolResult && typeof toolResult === "object" && "name" in toolResult) {
    const name = (toolResult as { name: unknown }).name;
    return typeof name === "string" ? name : undefined;
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
  let { text, toolCalls, tools, images, warnings, authorPaths } = prev;
  // Follow the stream: an authored chunk names a chain that is running now and
  // joins the set — several children speak at once under `dispatch_agents`, while
  // a chain it is nested with has evidently finished. An unauthored chunk means
  // the top-level agent has control again, and none of them is still running.
  const path = chunkAuthorPath(chunk);
  authorPaths = path ? trackActivePath(authorPaths, path) : [];
  if (typeof chunk.delta?.content === "string" && isTopLevelChunk(chunk)) {
    text += chunk.delta.content;
  }
  if (Array.isArray(chunk.delta?.toolCalls)) {
    toolCalls = [...toolCalls, ...chunk.delta.toolCalls.map(parseWireToolCall)];
  }
  if (chunk.toolResult !== undefined) {
    tools = [
      ...tools,
      { name: toolResultName(chunk.toolResult), content: stringifyToolResult(chunk.toolResult) },
    ];
  }
  if (chunk.image) {
    images = [...images, chunk.image];
  }
  if (typeof chunk.warning === "string" && !warnings.includes(chunk.warning)) {
    // A nested run can report the same unusable binding as its parent; the
    // reader only needs to be told once.
    warnings = [...warnings, chunk.warning];
  }
  return { text, toolCalls, tools, images, warnings, authorPaths };
}
