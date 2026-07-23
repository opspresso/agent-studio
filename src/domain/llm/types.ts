/**
 * LLM engine public contract types.
 * These are pure domain shapes with no framework/provider imports.
 */

/** Token + cost accounting for a single LLM call. */
export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** OpenAI-compatible chat message shape accepted by the engine. */
export interface ChatMessageInput {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  name?: string;
  /** Present on assistant messages that requested tool calls. */
  tool_calls?: unknown[];
  /** Present on tool messages. */
  tool_call_id?: string;
  /** Anthropic-style reasoning carried on assistant turns. */
  reasoning_content?: string;
}

/** A single streamed unit emitted by the engine's async generators. */
export interface EngineChunk {
  /** Project/agent that authored this chunk; set only when subagents are wired. */
  author?: string;
  delta?: {
    content?: string;
    reasoningContent?: string;
    toolCalls?: unknown[];
  };
  /** Emitted when the builtin GenerateImage tool produced an image. */
  image?: { b64: string; mimeType: string; prompt?: string };
  /** Emitted after a tool (MCP / Skill) finished executing. */
  toolResult?: {
    toolCallId: string;
    /** Display name; Skill loads include the loaded skill ("Skill: <name>"). */
    name: string;
    content: string;
  };
  usage?: UsageInfo;
  error?: string;
  done?: boolean;
}

/** Result of a single-shot (non-agent) run. */
export interface RunResult {
  content: string;
  /** The model actually used (may be the fallback model). */
  model: string;
  usage: UsageInfo;
  toolCalls?: unknown[];
}

/** Sampling / generation parameters resolved from a version. */
export interface EngineParameters {
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
  piiFiltering?: boolean;
  /** JSON schema for structured output; when present, response_format is set. */
  jsonSchema?: Record<string, unknown>;
  structuredOutput?: boolean;
}
