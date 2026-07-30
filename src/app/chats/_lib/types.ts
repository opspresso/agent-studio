import type { Chat, ChatMessage } from "@/domain/chat/types";

export type { Chat, ChatMessage };

/** A single SSE frame from a chat stream. */
export interface StreamChunk {
  chat?: Chat;
  delta?: { content?: string; toolCalls?: unknown[] };
  toolResult?: unknown;
  image?: { b64: string; mimeType: string; prompt?: string };
  author?: string;
  /** Transfer chain that produced the chunk, outermost first. */
  authorPath?: string[];
  /** A binding the run could not use; the run still answers. */
  warning?: string;
  error?: string;
}

export interface LiveToolCall {
  name: string;
  args: string;
}

export interface LiveToolResult {
  name?: string;
  content: string;
}

export interface LiveImage {
  b64: string;
  mimeType: string;
  prompt?: string;
}

/** In-progress assistant turn rendered while a stream is active. */
export interface LiveTurn {
  text: string;
  toolCalls: LiveToolCall[];
  tools: LiveToolResult[];
  images: LiveImage[];
  /** Bindings this run could not use, reported before the answer starts. */
  warnings: string[];
  /**
   * The chains currently producing chunks, each outermost first — cleared when
   * the top-level agent takes over again, so a badge never claims a subagent is
   * still running after it returned.
   *
   * A set rather than one chain: `dispatch_agents` has several children speaking
   * at the same time, and a single slot would flicker between them.
   */
  authorPaths: string[][];
}

export interface AgentProject {
  name: string;
  displayName: string;
  projectType: string;
}

export const EMPTY_TURN: LiveTurn = {
  text: "",
  toolCalls: [],
  tools: [],
  images: [],
  warnings: [],
  authorPaths: [],
};
