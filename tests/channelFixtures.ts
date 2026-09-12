/** Wire scripts used only by model-adapter tests; production uses SDK ModelProvider. */
import type { ChannelToolCall, ChannelParams } from "@/domain/llm/channel";
export type { ChannelToolCall, ChannelParams, ChannelMessage, ChannelToolDef } from "@/domain/llm/channel";

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
