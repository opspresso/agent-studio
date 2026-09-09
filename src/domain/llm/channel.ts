/**
 * Port for the single OpenAI-compatible LLM channel.
 * The engine (application layer) depends on this abstraction; the concrete
 * client lives in `src/infrastructure/llm/channel.ts`. Tests inject a fake.
 */

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

export interface ChannelUsage {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  } | null;
  completion_tokens_details?: {
    /** Tokens spent thinking — already inside `completion_tokens`, not beside it. */
    reasoning_tokens?: number;
  } | null;
  /**
   * USD the channel says the call actually cost, when it says so at all.
   *
   * A router bills its own rate for a model whose vendor publishes another, and
   * it may route the same id to a different upstream from one call to the next —
   * so the registry's price is an estimate there, and this is the invoice.
   * Absent for every channel that reports only tokens, which is most of them.
   */
  cost_usd?: number;
}

export interface ChannelDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: ChannelToolCall[];
}

export interface ChannelChunk {
  choices: Array<{
    delta: ChannelDelta;
    finish_reason?: string | null;
  }>;
  usage?: ChannelUsage | null;
}

export interface ChannelMessageResult {
  role: string;
  content: string | null;
  reasoning_content?: string | null;
  tool_calls?: ChannelToolCall[];
}

export interface ChannelCompletion {
  choices: Array<{
    message: ChannelMessageResult;
    finish_reason?: string | null;
  }>;
  usage?: ChannelUsage | null;
  model?: string;
}

export interface LlmChannel {
  chatCompletion(params: ChannelParams): Promise<ChannelCompletion>;
  chatCompletionStream(params: ChannelParams): AsyncIterable<ChannelChunk>;
}
