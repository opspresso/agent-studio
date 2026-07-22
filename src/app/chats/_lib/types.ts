import type { Chat, ChatMessage } from "@/domain/chat/types";

export type { Chat, ChatMessage };

/** A single SSE frame from a chat stream. */
export interface StreamChunk {
  chat?: Chat;
  delta?: { content?: string; toolCalls?: unknown[] };
  toolResult?: unknown;
  image?: { b64: string; mimeType: string; prompt?: string };
  author?: string;
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
  author?: string;
}

export interface AgentProject {
  name: string;
  displayName: string;
  projectType: string;
}

export const EMPTY_TURN: LiveTurn = { text: "", toolCalls: [], tools: [], images: [] };
