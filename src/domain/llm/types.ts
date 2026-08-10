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

/** One OpenAI-shaped tool call as it appears on assistant messages and deltas. */
export interface ChannelToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

/**
 * One part of a multimodal message body, in the OpenAI content-parts shape.
 * Image bytes travel as a `data:<mime>;base64,…` URL.
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

/** OpenAI-compatible chat message shape accepted by the engine. */
export interface ChatMessageInput {
  role: "system" | "user" | "assistant" | "tool";
  /** Plain text, or content parts when the turn carries images. */
  content?: string | ContentPart[] | null;
  name?: string;
  /** Present on assistant messages that requested tool calls. */
  tool_calls?: ChannelToolCall[];
  /** Present on tool messages. */
  tool_call_id?: string;
  /** Anthropic-style reasoning carried on assistant turns. */
  reasoning_content?: string;
}

/**
 * Why a run's stream ended. The four endings are distinct values, not
 * inferences: a consumer that reasons "no `done` seen → stopped at a limit"
 * misreads a cancellation and a mid-stream error as a length stop, which is
 * exactly the bug this type exists to make un-writable.
 *
 * - `completed` — the model finished on its own (`done: true` on the wire).
 * - `turn-limit` — the turn guard ended the loop (`finishReason` on the wire).
 * - `output-limit` — the provider cut the response at its output cap
 *   (`finish_reason: "length"` from the channel; `finishReason` on the wire).
 *   Distinct from `turn-limit`: there the loop stopped but no text was cut,
 *   here the answer itself is truncated.
 * - `error` — the run failed mid-stream (`error` on the wire).
 * - `cancelled` — never a chunk: a cancelled generator throws or is returned,
 *   so only the consumer's own signal can say it. The value exists so code
 *   classifying a run's ending has one vocabulary for all of them.
 */
export type RunTerminationReason =
  | "completed"
  | "turn-limit"
  | "output-limit"
  | "cancelled"
  | "error";

/** A single streamed unit emitted by the engine's async generators. */
export interface EngineChunk {
  /** Internal correlation id for a traced subagent execution. */
  traceId?: string;
  /**
   * Subagent that authored this chunk — the *innermost* one, so a nested
   * transfer reports who actually ran. Top-level chunks carry no author.
   */
  author?: string;
  /**
   * The transfer chain that produced this chunk, outermost first
   * (`["sample-agent", "simple-image"]`). Absent on top-level chunks; its last
   * element is always {@link author}.
   */
  authorPath?: string[];
  /** This authored run returned; consumers should stop showing its chain as active. */
  authorDone?: boolean;
  delta?: {
    content?: string;
    reasoningContent?: string;
    toolCalls?: ChannelToolCall[];
  };
  /** Emitted when the builtin GenerateImage tool produced an image. */
  image?: { b64: string; mimeType: string; prompt?: string };
  /** Emitted after a tool (MCP / Skill) finished executing. */
  toolResult?: {
    toolCallId: string;
    /**
     * Display name, and only that — the context receives `content` and the call
     * id. It carries what the tool acted on after a colon: the skill a `Skill`
     * load read, the agent a transfer went to, and the server an MCP tool came
     * from ("aws-knowledge: aws___search_documentation"), which the tool's own
     * name never says.
     */
    name: string;
    content: string;
    /**
     * Report what ran, but never stand in for the call's result in context. A
     * transfer's real answer comes back as its own message, so replaying this
     * marker instead would tell the model the delegation returned nothing.
     */
    displayOnly?: boolean;
  };
  usage?: UsageInfo;
  /**
   * The run goes on, but in a shape the user has to be told about — a skill or
   * subagent whose registry entry is gone, an MCP server whose tools could not
   * be reached. Without this such a run is indistinguishable from a model that
   * simply chose not to call anything. Unlike {@link error} it never ends the
   * stream, and it carries no answer text.
   */
  warning?: string;
  error?: string;
  done?: boolean;
  /**
   * Why the run ended, when `done` cannot say it. Normal completion stays
   * `done: true` — byte-identical to what every existing consumer reads — and
   * an ending that is *not* a normal completion carries its reason here
   * instead, so a consumer written before this field behaves exactly as it did.
   * Narrowed to the reasons only this field can say: `completed` is `done`,
   * `error` has its own field, and `cancelled` is never a chunk — so a
   * producer cannot write the ambiguous endings the reader exists to forbid.
   * Read through {@link chunkTermination}, never by field presence.
   */
  finishReason?: Extract<RunTerminationReason, "turn-limit" | "output-limit">;
}

/**
 * True for chunks belonging to the top-level run's visible answer stream.
 * The single owned predicate — every stream consumer must use this instead of
 * re-deriving author semantics.
 *
 * Takes the `author` field alone so client-side wire shapes (the browser's own
 * chunk interface) can use the same predicate rather than re-deriving it.
 */
export function isTopLevelChunk(chunk: { author?: string }): boolean {
  return chunk.author === undefined;
}

/**
 * The termination a chunk announces, or undefined for a chunk that is not a
 * run's ending. The single owned reader of the `done` / `finishReason` /
 * `error` fields — like {@link isTopLevelChunk}, consumers call this instead
 * of re-deriving the mapping, because the re-derivation every consumer used to
 * make ("no `done` → cut off at a limit") misreads a cancellation and a
 * mid-stream error as a length stop.
 *
 * Only a top-level chunk's termination speaks for the stream. An authored one
 * is informational: a child's ending is absorbed into the parent's tool result,
 * and the end of the child's stream is already said by `authorDone`.
 */
export function chunkTermination(
  chunk: Pick<EngineChunk, "done" | "finishReason" | "error">,
): RunTerminationReason | undefined {
  if (chunk.error !== undefined) {
    return "error";
  }
  if (chunk.finishReason !== undefined) {
    return chunk.finishReason;
  }
  return chunk.done ? "completed" : undefined;
}

/**
 * The termination this chunk announces *for the run* — {@link isTopLevelChunk}
 * and {@link chunkTermination} composed, because every consumer that asked the
 * two questions separately was one forgotten gate away from reading a child's
 * ending as the stream's (which is exactly how an authored error once failed a
 * whole A2A task).
 */
export function runTermination(
  chunk: Pick<EngineChunk, "author" | "done" | "finishReason" | "error">,
): RunTerminationReason | undefined {
  return isTopLevelChunk(chunk) ? chunkTermination(chunk) : undefined;
}

/**
 * The warning this chunk adds to a run's collected losses, or undefined when
 * it adds nothing. The single owned collector — like {@link chunkTermination},
 * consumers call this instead of re-deriving which warnings count, because the
 * re-derivations had already split three ways: two surfaces kept only
 * top-level warnings (dropping every loss a subagent reported), and three
 * repeated what the reader had already been told.
 *
 * Authored warnings are kept: a subagent's warning names its own agent, and
 * its loss is the caller's as much as a top-level one. Deduplicated against
 * what the caller already collected: several children can report the same
 * missing binding, and the reader only needs to be told once.
 *
 * Takes the `warning` field alone so client-side wire shapes can use the same
 * collector, like {@link isTopLevelChunk}.
 */
export function collectedWarning(
  chunk: { warning?: string },
  collected: readonly string[],
): string | undefined {
  if (!chunk.warning || collected.includes(chunk.warning)) {
    return undefined;
  }
  return chunk.warning;
}

/**
 * Flatten a message body to plain text — the single owned reader for code that
 * needs the words of a turn (templates, prompts, logs). Image parts contribute
 * nothing; callers that care about images use {@link hasImageParts}.
 */
export function messageText(message: Pick<ChatMessageInput, "content">): string {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!content) {
    return "";
  }
  return content
    .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/**
 * Encode image bytes as the `data:` url an `image_url` content part carries.
 * Every surface that inlines an image goes through here, so the encoding has
 * one owner alongside the decoder below.
 */
export function imageDataUrl(image: { b64: string; mimeType: string }): string {
  return `data:${image.mimeType};base64,${image.b64}`;
}

/**
 * Decode a `data:<mime>;base64,<payload>` url into bytes — the inverse of
 * `imageDataUrl`. Any other url form (an https image the provider fetches for
 * itself) returns null.
 */
export function parseImageDataUrl(url: string): { b64: string; mimeType: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  const mimeType = match?.[1];
  const b64 = match?.[2];
  if (!mimeType || !b64 || !mimeType.startsWith("image/")) {
    return null;
  }
  return { b64, mimeType };
}

/** True when a message body carries at least one image part. */
export function hasImageParts(message: Pick<ChatMessageInput, "content">): boolean {
  return Array.isArray(message.content) && message.content.some((p) => p.type === "image_url");
}

/**
 * What one MCP tool call produced: the text the model reads, plus any image
 * blocks the server returned. Images travel separately because a `tool` message
 * carries text only — the engine attaches them to the turn as image parts, the
 * same way a subagent transfer hands a picture back.
 */
export interface McpToolResult {
  text: string;
  images?: Array<{ b64: string; mimeType: string }>;
}

/** Result of a single-shot (non-agent) run. */
export interface RunResult {
  content: string;
  /** The model actually used (may be the fallback model). */
  model: string;
  usage: UsageInfo;
  toolCalls?: ChannelToolCall[];
  /**
   * Why the run ended — for a single-shot run, `completed` or `output-limit`
   * (the provider cut the response at its output cap, which used to be
   * indistinguishable from a finish).
   */
  termination?: RunTerminationReason;
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
