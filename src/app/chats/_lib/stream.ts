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

/**
 * Fold one stream chunk into the live assistant turn. Subagent-authored content
 * (chunk carries `author`) is not merged into the visible answer but its label is
 * surfaced as a badge — mirroring what the server persists.
 */
export function reduceChunk(prev: LiveTurn, chunk: StreamChunk): LiveTurn {
  let { text, tools, author } = prev;
  if (chunk.author) {
    author = chunk.author;
  }
  if (typeof chunk.delta?.content === "string" && !chunk.author) {
    text += chunk.delta.content;
  }
  if (chunk.toolResult !== undefined) {
    tools = [...tools, stringifyToolResult(chunk.toolResult)];
  }
  return { text, tools, author };
}
