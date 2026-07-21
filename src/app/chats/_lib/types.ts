import type { Chat, ChatMessage } from "@/domain/chat/types";

export type { Chat, ChatMessage };

/** A single SSE frame from a chat stream. */
export interface StreamChunk {
  chat?: Chat;
  delta?: { content?: string };
  toolResult?: unknown;
  author?: string;
  error?: string;
}

/** In-progress assistant turn rendered while a stream is active. */
export interface LiveTurn {
  text: string;
  tools: string[];
  author?: string;
}

export interface AgentProject {
  name: string;
  displayName: string;
  projectType: string;
}

export const EMPTY_TURN: LiveTurn = { text: "", tools: [] };
