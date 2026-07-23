/**
 * Port for the single OpenAI-compatible LLM channel.
 * The engine (application layer) depends on this abstraction; the concrete
 * client lives in `src/infrastructure/llm/channel.ts`. Tests inject a fake.
 */

export interface ChannelToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

import type { ChatMessageInput } from "./types";

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

export interface ChannelParams {
  model: string;
  messages: ChannelMessage[];
  tools?: ChannelToolDef[];
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
  responseFormat?: Record<string, unknown>;
}

export interface ChannelUsage {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  } | null;
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
