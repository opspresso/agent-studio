/** OpenAI-compatible request vocabulary accepted at Studio's API boundary. */
import type { ChannelToolCall, ChatMessageInput } from "./types";

export type { ChannelToolCall };

/**
 * The wire message is the same OpenAI-compatible shape the engine accepts —
 * one domain message type, no translation layer between engine and channel.
 */
export type ChannelMessage = ChatMessageInput;

export interface ChannelToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export const PRESENCE_PENALTY_RANGE = { min: -2, max: 2 } as const;

export interface ChannelParams {
  model: string;
  messages: ChannelMessage[];
  signal?: AbortSignal;
  tools?: ChannelToolDef[];
  temperature?: number;
  presencePenalty?: number;
  maxTokens?: number;
  reasoningEffort?: "low" | "medium" | "high" | "none";
  responseFormat?: Record<string, unknown>;
}
