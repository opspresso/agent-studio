/**
 * LLM engine. Runs prompt and agent executions over a single
 * OpenAI-compatible channel:
 *   - runPrompt / runPromptStream: single-shot generation with fallback retry.
 *   - runAgent: recursive multi-turn tool loop (a builtin serves a call only when
 *     it was offered this run; other names dispatch to MCP, concurrently).
 *
 * Pure application logic: the channel, usage recorder, MCP dispatcher, skill
 * loader and subagent runner are all injected so the loop is testable without
 * network or DynamoDB.
 */

import type {
  ChannelChunk,
  ChannelCompletion,
  ChannelMessage,
  ChannelParams,
  ChannelToolCall,
  ChannelToolDef,
  ChannelUsage,
  LlmChannel,
} from "@/domain/llm/channel";
import type { RunCaller } from "@/domain/execution/actor";
import {
  applyModelConstraints,
  calculateCost,
  describeImageInputReject,
} from "@/domain/llm/models";
import { hasImageParts, imageDataUrl, parseImageDataUrl } from "@/domain/llm/types";
import type {
  ChatMessageInput,
  EngineChunk,
  EngineParameters,
  McpToolResult,
  RunResult,
  UsageInfo,
} from "@/domain/llm/types";
import { MAX_ATTACHMENTS } from "@/domain/llm/imageLimits";
import { ValidationError } from "@/application/errors";
import { createRunContextBudget, type RunContextBudget } from "./contextBudget";
import { PiiFilter } from "./pii";
import { renderTemplate } from "./template";
import { formatRunClock } from "@/shared/date";
import { mergeGenerators } from "@/shared/mergeGenerators";
import { log } from "@/shared/logger";
import { cutCodePoints } from "@/shared/utf8Text";

export const SKILL_TOOL_NAME = "Skill";
export const TRANSFER_TOOL_NAME = "transfer_to_agent";
export const DISPATCH_TOOL_NAME = "dispatch_agents";
export const IMAGE_TOOL_NAME = "GenerateImage";
export const EDIT_IMAGE_TOOL_NAME = "EditImage";
/**
 * Every name a builtin may claim. An MCP tool that arrives under one of these
 * must be aliased even when that builtin is inactive for the run: whether a
 * builtin is offered depends on the version, while the alias must be stable and
 * decided before the run's tool set is built.
 */
export const BUILTIN_TOOL_NAMES: readonly string[] = [
  SKILL_TOOL_NAME,
  TRANSFER_TOOL_NAME,
  DISPATCH_TOOL_NAME,
  IMAGE_TOOL_NAME,
  EDIT_IMAGE_TOOL_NAME,
];

/**
 * Agents one `dispatch_agents` call may run at once.
 *
 * Lower than the MCP ceiling on purpose: a child is a whole run — its own tool
 * resolution, MCP sessions and multi-turn loop — not one request. And it is a
 * hard bound rather than a queue because a subagent run does not pass through
 * the run bracket, so these children are outside the concurrency and cost
 * guards; the only thing limiting them is this number and the fact that a child
 * is never offered this tool.
 */
const MAX_DISPATCH_TASKS = 4;
const DEFAULT_MAX_TURN = 50;
/**
 * What separates one turn's words from the next turn's in the flattened answer.
 *
 * A blank line rather than a space: these are separate statements a step apart,
 * not a continued sentence, and every surface that renders the answer — Slack,
 * the chat bubble, an OpenAI client — reads a blank line as a paragraph break.
 */
const TURN_SEPARATOR = "\n\n";

/** An image this run can edit, addressed by a short id the model can quote. */
interface ImageHandle {
  id: string;
  b64: string;
  mimeType: string;
  origin: string;
}

/**
 * The images EditImage can reach in one run: the user's inline attachments plus
 * everything the run has drawn so far. Ids are stable for the run and travel to
 * the model through the system prompt and the image tool results.
 */
class ImageRegistry {
  private readonly handles: ImageHandle[] = [];

  add(image: { b64: string; mimeType: string }, origin: string): ImageHandle {
    const handle: ImageHandle = { id: `img_${this.handles.length + 1}`, ...image, origin };
    this.handles.push(handle);
    return handle;
  }

  get(id: string): ImageHandle | undefined {
    return this.handles.find((handle) => handle.id === id);
  }

  list(): readonly ImageHandle[] {
    return this.handles;
  }
}

/**
 * Register every inline image in the input messages. An https image part is
 * skipped: the provider fetches those itself, so the bytes an edit needs are
 * not in hand.
 */
function registerInputImages(registry: ImageRegistry, messages: ChatMessageInput[]): void {
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (part.type !== "image_url") {
        continue;
      }
      const bytes = parseImageDataUrl(part.image_url.url);
      if (bytes) {
        registry.add(bytes, message.role === "assistant" ? "an earlier answer" : "sent by the user");
      }
    }
  }
}

export type RecordUsageFn = (record: {
  projectName: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}) => Promise<void>;

export interface SkillInfo {
  name: string;
  description: string;
}

export interface SubagentInfo {
  name: string;
  description: string;
  type: "local" | "remote";
}

/** Connected MCP server overview; tool names are the aliased names the model sees. */
export interface McpServerInfo {
  name: string;
  description: string;
  toolNames: string[];
}

export interface EngineDeps {
  channel: LlmChannel;
  recordUsage?: RecordUsageFn;
}

export interface AgentDeps extends EngineDeps {
  /** Dispatch an MCP tool by its (aliased) name. */
  callMcpTool?: (name: string, args: Record<string, unknown>) => Promise<McpToolResult>;
  /** Load full skill content for progressive disclosure. */
  loadSkillContent?: (skillName: string, filePath?: string) => Promise<string>;
  /**
   * Run a subagent transfer. Yields the child's (already authored) stream
   * chunks and returns the child's final text for the "For context" message.
   */
  runSubagent?: (
    agentName: string,
    message: string,
    turn: number,
    maxTurn: number,
    /** Images the parent handed over; the child edits or looks at them. */
    images?: Array<{ b64: string; mimeType: string }>,
    /**
     * The conversation the child was not part of, already rendered and budgeted
     * (see {@link buildTransferTranscript}). Passed separately from `message`
     * because only the runner knows the child's type: an image child's message
     * *is* its image prompt, so a transcript must never be folded into it.
     */
    transcript?: string,
  ) => AsyncGenerator<EngineChunk, string>;
  /** Generate an image for the builtin GenerateImage tool. */
  generateImage?: (
    prompt: string,
    size?: string,
    quality?: string,
  ) => Promise<{ b64: string; mimeType: string }>;
  /**
   * Edit existing image bytes for the builtin EditImage tool. The engine owns the
   * handle bookkeeping and hands over the resolved bytes, so this stays pure I/O.
   */
  editImage?: (params: {
    prompt: string;
    images: Array<{ b64: string; mimeType: string }>;
    size?: string;
    quality?: string;
  }) => Promise<{ b64: string; mimeType: string }>;
}

export interface RunPromptInput {
  projectName?: string;
  model: string;
  fallbackModel?: string;
  systemPrompt?: string;
  userPromptTemplate: string;
  variables?: Record<string, string>;
  extraMessages?: ChatMessageInput[];
  parameters?: EngineParameters;
  /**
   * The run's wall clock, injected rather than read: the engine stays pure and
   * its tests stay off the real clock. Omitted leaves the prompt exactly as it
   * was before there was a clock.
   */
  now?: Date;
  /** Who is asking. Absent leaves the prompt exactly as it was without one. */
  caller?: RunCaller;
  signal?: AbortSignal;
}

export interface RunAgentInput {
  projectName: string;
  model: string;
  fallbackModel?: string;
  systemPrompt?: string;
  messages: ChatMessageInput[];
  parameters?: EngineParameters;
  /** See {@link RunPromptInput.now} — injected, never read from the clock here. */
  now?: Date;
  /** See {@link RunPromptInput.caller}. */
  caller?: RunCaller;
  /**
   * Whether this run may fan out to several agents at once. Set by the top-level
   * execution facade only — a subagent run is never given the tool, so the number
   * of children a request can start does not grow with transfer depth.
   */
  canDispatch?: boolean;
  maxTurn?: number;
  /** Starting turn, used when a subagent continues the parent's turn budget. */
  startTurn?: number;
  /**
   * The conversation to hand to anything this run transfers to. Set by a
   * subagent runner so the *original* chat travels down the whole chain: a
   * child's own `messages` are the one synthetic turn it was handed, and
   * deriving from those would nest each hop's transcript inside the next.
   */
  transcript?: string;
  skills?: SkillInfo[];
  subagents?: SubagentInfo[];
  /** MCP tool definitions, already aliased for name collisions. */
  mcpTools?: ChannelToolDef[];
  /** Per-server grouping of the MCP tools, for the system prompt overview. */
  mcpServers?: McpServerInfo[];
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** MCP calls of one response that may be in flight at once. */
const MAX_PARALLEL_TOOL_CALLS = 5;

/**
 * Tool-result text one turn may add to the context. Each result is already
 * capped on its own, but a turn holding several of them plus a whole skill body
 * would blow the context window (or the bill) before the provider complains.
 */
const MAX_TOOL_RESULT_CHARS_PER_TURN = 200_000;

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      const item = items[index];
      if (index >= items.length || item === undefined) {
        return;
      }
      results[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Below this, a run-budget-truncated result reads as data while carrying none
 * of it — the same judgement {@link MIN_TRANSFER_LINE_CHARS} makes for a
 * transcript line — so the result is omitted with a reason instead.
 */
const MIN_KEPT_RESULT_CHARS = 500;

/**
 * Spend one turn's tool-result budget in call order. Truncation is explicit so
 * the model can narrow its next call instead of silently working from a cut-off
 * payload; an entirely omitted result is reported as an error, which also makes
 * budget exhaustion visible as a failed span in the trace.
 *
 * The run-level context budget sits underneath: what survives the per-turn cap
 * must still fit what the whole run may accumulate, so a small-window model
 * truncates below the per-turn cap instead of overflowing into a provider 400.
 */
function createToolResultBudget(
  total: number,
  runBudget?: RunContextBudget,
): (content: string) => string {
  let remaining = total;
  return (content) => {
    let text: string;
    if (content.length <= remaining) {
      remaining -= content.length;
      text = content;
    } else {
      const room = remaining;
      remaining = 0;
      if (room <= 0) {
        // The tool protocol forces a result message per call, so this string
        // enters the context regardless — charged, so the budget stays honest
        // about it instead of the gap widening silently.
        const omitted =
          "Error: tool result omitted — this turn's tool output budget is exhausted. Request less data, or call one tool at a time.";
        runBudget?.chargeText(omitted);
        return omitted;
      }
      text = `${content.slice(0, room)}\n…(truncated: kept ${room} of ${content.length} chars, this turn's tool output budget is exhausted)`;
    }
    if (!runBudget) {
      return text;
    }
    // The marker is reserved inside the fit, not appended after it — a marker
    // on top of a fit that spent the whole budget is how uncharged strings
    // accumulate until the overflow the budget exists to prevent returns.
    const fitted = runBudget.fitText(text, {
      suffix: "\n…(truncated: the run's context budget is exhausted)",
      minKeepChars: MIN_KEPT_RESULT_CHARS,
    });
    if (!fitted.truncated) {
      return text;
    }
    if (!fitted.kept) {
      const omitted =
        "Error: tool result omitted — the run's context budget is exhausted. Answer from what you already have.";
      runBudget.chargeText(omitted);
      return omitted;
    }
    return fitted.text;
  };
}

/** 429 or 5xx are the only fallback-eligible errors, matching FallbackRunner. */
function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const e = error as { status?: number; statusCode?: number; code?: number };
  const code = e.status ?? e.statusCode ?? (typeof e.code === "number" ? e.code : undefined);
  if (code === undefined) {
    return false;
  }
  return code === 429 || (code >= 500 && code < 600);
}

/**
 * Gate an image-bearing run on the primary model, and report whether the run
 * carries images at all. Images only enter through the input messages (tool
 * results are text), so one check at entry covers every turn of the loop.
 */
function assertImageInputAllowed(model: string, messages: ChatMessageInput[]): boolean {
  if (!messages.some(hasImageParts)) {
    return false;
  }
  const reject = describeImageInputReject(model);
  if (reject) {
    throw new ValidationError(reject);
  }
  return true;
}

/**
 * The fallback model for a run, dropped when the run carries images the fallback
 * cannot read — a misconfigured fallback must not fail a request the primary
 * model can serve.
 */
function imageEligibleFallback(fallbackModel: string | undefined, withImages: boolean): string | undefined {
  if (!fallbackModel || !withImages) {
    return fallbackModel;
  }
  const reject = describeImageInputReject(fallbackModel);
  if (!reject) {
    return fallbackModel;
  }
  log.warn("engine", `fallback skipped for an image request: ${reject}`);
  return undefined;
}

function toUsageInfo(model: string, usage: ChannelUsage | null | undefined): UsageInfo {
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const costUsd = calculateCost(model, { inputTokens, outputTokens, cachedTokens });
  return { inputTokens, outputTokens, costUsd };
}

function buildChannelParams(
  model: string,
  messages: ChannelMessage[],
  parameters?: EngineParameters,
  tools?: ChannelToolDef[],
  signal?: AbortSignal,
): ChannelParams {
  const params: ChannelParams = { model, messages, signal };
  if (parameters?.temperature !== undefined) {
    params.temperature = parameters.temperature;
  }
  if (parameters?.maxTokens !== undefined) {
    params.maxTokens = parameters.maxTokens;
  }
  if (parameters?.reasoningEffort !== undefined) {
    params.reasoningEffort = parameters.reasoningEffort;
  }
  if (parameters?.structuredOutput && parameters.jsonSchema) {
    params.responseFormat = {
      type: "json_schema",
      json_schema: { name: "response", schema: parameters.jsonSchema },
    };
  }
  if (tools && tools.length > 0) {
    params.tools = tools;
  }
  return applyModelConstraints(params);
}

async function completionWithFallback(
  channel: LlmChannel,
  params: ChannelParams,
  fallbackModel: string | undefined,
): Promise<{ completion: ChannelCompletion; modelUsed: string }> {
  try {
    const completion = await channel.chatCompletion(params);
    return { completion, modelUsed: params.model };
  } catch (error) {
    if (fallbackModel && isRetryableError(error)) {
      const completion = await channel.chatCompletion(
        applyModelConstraints({ ...params, model: fallbackModel }),
      );
      return { completion, modelUsed: fallbackModel };
    }
    throw error;
  }
}

/**
 * Stream with a single fallback retry. Falls back only when the primary call
 * fails retryably *before* any chunk is yielded (a partial stream can't retry).
 * `state.model` is updated to the fallback model when it is used.
 */
async function* streamWithFallback(
  channel: LlmChannel,
  params: ChannelParams,
  fallbackModel: string | undefined,
  state: { model: string },
): AsyncGenerator<ChannelChunk> {
  let yieldedAny = false;
  try {
    for await (const chunk of channel.chatCompletionStream(params)) {
      yieldedAny = true;
      yield chunk;
    }
    return;
  } catch (error) {
    if (!fallbackModel || yieldedAny || !isRetryableError(error)) {
      throw error;
    }
  }
  state.model = fallbackModel;
  for await (const chunk of channel.chatCompletionStream(
    applyModelConstraints({ ...params, model: fallbackModel }),
  )) {
    yield chunk;
  }
}

async function recordUsageIfPossible(
  deps: EngineDeps,
  projectName: string | undefined,
  model: string,
  usage: UsageInfo,
): Promise<void> {
  if (!deps.recordUsage || !projectName) {
    return;
  }
  try {
    await deps.recordUsage({
      projectName,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
    });
  } catch (error) {
    // Usage recording is telemetry: a write failure must not turn a successful
    // generation into an error. The agent aggregator already guarantees this;
    // single-shot runs record inline, so swallow here too.
    log.error("engine", "usage recording failed", errorMessage(error));
  }
}

// ---------------------------------------------------------------------------
// Single-shot generation
// ---------------------------------------------------------------------------

/**
 * Keys whose values are opaque payloads, not prose: an image data URL carries no
 * PII to mask, and rewriting it (a base64 run can look like a phone number)
 * would corrupt the image.
 */
const OPAQUE_KEYS = new Set(["image_url"]);

function maskValues(filter: PiiFilter, value: unknown): unknown {
  if (typeof value === "string") {
    return filter.mask(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskValues(filter, item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        OPAQUE_KEYS.has(key) ? item : maskValues(filter, item),
      ]),
    );
  }
  return value;
}

function maskMessage(filter: PiiFilter, message: ChannelMessage): ChannelMessage {
  return maskValues(filter, message) as ChannelMessage;
}

function restoreValues(filter: PiiFilter, value: unknown): unknown {
  if (typeof value === "string") {
    return filter.restore(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => restoreValues(filter, item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        OPAQUE_KEYS.has(key) ? item : restoreValues(filter, item),
      ]),
    );
  }
  return value;
}

/**
 * One entry of a `dispatch_agents` call once it has been validated. A task that
 * cannot run carries its reason instead of a message, so it keeps its place in
 * the result without being dispatched.
 */
type DispatchPlan =
  | { agentName: string; failure: string }
  | {
      agentName: string;
      message: string;
      childImages: Array<{ b64: string; mimeType: string }>;
    };

/**
 * Pass a dispatched child's stream through, noting the first error it reported.
 *
 * A child never throws — the runner turns its failures into `error` chunks and
 * returns an empty string — so this is the only way to say *why* a task came back
 * with nothing.
 *
 * It does **not** decide that the task failed. An `error` chunk in a child's
 * stream is not the child ending: a nested transfer it could not reach arrives as
 * a tool error and the child may answer from it, and a deeper descendant's
 * failure travels out through this same stream. The returned text decides;
 * this only explains an empty one.
 */
async function* observeChildFailure(
  source: AsyncGenerator<EngineChunk, string>,
  sink: { error?: string },
): AsyncGenerator<EngineChunk, string> {
  while (true) {
    const step = await source.next();
    if (step.done) {
      return step.value;
    }
    if (step.value.error && sink.error === undefined) {
      sink.error = step.value.error;
    }
    yield step.value;
  }
}

async function* reportChildCompletion(
  source: AsyncGenerator<EngineChunk, string>,
  agentName: string,
): AsyncGenerator<EngineChunk, string> {
  const answer = yield* source;
  yield { author: agentName, authorPath: [agentName], authorDone: true };
  return answer;
}

async function* runSubagentWithPii(
  filter: PiiFilter,
  runSubagent: NonNullable<AgentDeps["runSubagent"]>,
  agentName: string,
  message: string,
  turn: number,
  maxTurn: number,
  images?: Array<{ b64: string; mimeType: string }>,
  transcript?: string,
): AsyncGenerator<EngineChunk, string> {
  // The transcript arrives already masked — it is derived from the run's input
  // messages and masked once at run start, like every other string that crosses
  // into a child.
  const source = runSubagent(agentName, message, turn, maxTurn, images, transcript);
  const contentRestorer = filter.createStreamRestorer();
  const reasoningRestorer = filter.createStreamRestorer();
  let author: string | undefined;
  let completed = false;

  try {
    while (true) {
      const step = await source.next();
      if (step.done) {
        completed = true;
        const content = contentRestorer.flush();
        if (content) {
          yield { author, delta: { content } };
        }
        const reasoningContent = reasoningRestorer.flush();
        if (reasoningContent) {
          yield { author, delta: { reasoningContent } };
        }
        return step.value;
      }

      const chunk = step.value;
      author = chunk.author ?? author;
      if (chunk.error) {
        const content = contentRestorer.flush();
        if (content) {
          yield { author, delta: { content } };
        }
        const reasoningContent = reasoningRestorer.flush();
        if (reasoningContent) {
          yield { author, delta: { reasoningContent } };
        }
      }

      const restored = restoreValues(filter, chunk) as EngineChunk;
      if (chunk.delta?.content) {
        const content = contentRestorer.push(chunk.delta.content);
        restored.delta = { ...restored.delta, content };
      }
      if (chunk.delta?.reasoningContent) {
        const reasoningContent = reasoningRestorer.push(chunk.delta.reasoningContent);
        restored.delta = { ...restored.delta, reasoningContent };
      }
      if (
        restored.delta &&
        !restored.delta.content &&
        !restored.delta.reasoningContent &&
        !restored.delta.toolCalls
      ) {
        delete restored.delta;
      }
      if (
        restored.delta ||
        restored.image ||
        restored.toolResult ||
        restored.usage ||
        restored.error ||
        restored.warning ||
        restored.finishReason ||
        restored.done
      ) {
        yield restored;
      }
    }
  } finally {
    if (!completed) {
      await source.return("");
    }
  }
}

/**
 * The messages a single-shot run sends: the system prompt, the rendered user
 * prompt template, then any history. Exported so the Playground preview shows
 * this assembly rather than a second implementation of it.
 */
export function buildPromptMessages(input: RunPromptInput, filter?: PiiFilter): ChannelMessage[] {
  const messages: ChannelMessage[] = [];
  // The same boundary the agent prompt uses. A single-shot run has no capability
  // block, so the clock is the only thing that can sit behind the break — and
  // with no clock the author's text is sent exactly as it was.
  const systemPrompt = withEngineBlocks(input.systemPrompt, [
    ...(input.now ? [runClockBlock(input.now)] : []),
    ...(input.caller ? [callerBlock(input.caller)] : []),
  ]);
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  const rendered = renderTemplate(input.userPromptTemplate, input.variables);
  if (rendered) {
    messages.push({ role: "user", content: rendered });
  }
  if (input.extraMessages && input.extraMessages.length > 0) {
    messages.push(...(input.extraMessages as ChannelMessage[]));
  }
  return filter ? messages.map((message) => maskMessage(filter, message)) : messages;
}

export async function runPrompt(deps: EngineDeps, input: RunPromptInput): Promise<RunResult> {
  const withImages = assertImageInputAllowed(input.model, input.extraMessages ?? []);
  const filter = input.parameters?.piiFiltering ? new PiiFilter() : undefined;
  const messages = buildPromptMessages(input, filter);
  const params = buildChannelParams(
    input.model,
    messages,
    input.parameters,
    undefined,
    input.signal,
  );
  const { completion, modelUsed } = await completionWithFallback(
    deps.channel,
    params,
    imageEligibleFallback(input.fallbackModel, withImages),
  );
  const choice = completion.choices[0];
  const content = filter?.restore(choice?.message.content ?? "") ?? choice?.message.content ?? "";
  const usage = toUsageInfo(modelUsed, completion.usage);
  await recordUsageIfPossible(deps, input.projectName, modelUsed, usage);

  const result: RunResult = { content, model: modelUsed, usage };
  if (choice?.message.tool_calls && choice.message.tool_calls.length > 0) {
    result.toolCalls = filter
      ? (restoreValues(filter, choice.message.tool_calls) as ChannelToolCall[])
      : choice.message.tool_calls;
  }
  return result;
}

export async function* runPromptStream(
  deps: EngineDeps,
  input: RunPromptInput,
): AsyncGenerator<EngineChunk> {
  const withImages = assertImageInputAllowed(input.model, input.extraMessages ?? []);
  const filter = input.parameters?.piiFiltering ? new PiiFilter() : undefined;
  const messages = buildPromptMessages(input, filter);
  const params = buildChannelParams(
    input.model,
    messages,
    input.parameters,
    undefined,
    input.signal,
  );
  const state = { model: input.model };
  let usage: ChannelUsage | null = null;
  const contentRestorer = filter?.createStreamRestorer();
  const reasoningRestorer = filter?.createStreamRestorer();

  try {
    for await (const chunk of streamWithFallback(
      deps.channel,
      params,
      imageEligibleFallback(input.fallbackModel, withImages),
      state,
    )) {
      if (chunk.usage) {
        usage = chunk.usage;
      }
      const delta = chunk.choices[0]?.delta;
      if (!delta) {
        continue;
      }
      // Independent checks, not a chain: a provider may carry content and
      // reasoning_content in the SAME delta, and an `else if` would drop one.
      if (delta.content) {
        const content = contentRestorer?.push(delta.content) ?? delta.content;
        if (content) {
          yield { delta: { content } };
        }
      }
      if (delta.reasoning_content) {
        const reasoningContent =
          reasoningRestorer?.push(delta.reasoning_content) ?? delta.reasoning_content;
        if (reasoningContent) {
          yield { delta: { reasoningContent } };
        }
      }
    }
  } catch (error) {
    input.signal?.throwIfAborted();
    const remainingContent = contentRestorer?.flush();
    if (remainingContent) {
      yield { delta: { content: remainingContent } };
    }
    const remainingReasoning = reasoningRestorer?.flush();
    if (remainingReasoning) {
      yield { delta: { reasoningContent: remainingReasoning } };
    }
    yield { error: errorMessage(error) };
    return;
  }

  const remainingContent = contentRestorer?.flush();
  if (remainingContent) {
    yield { delta: { content: remainingContent } };
  }
  const remainingReasoning = reasoningRestorer?.flush();
  if (remainingReasoning) {
    yield { delta: { reasoningContent: remainingReasoning } };
  }

  const usageInfo = toUsageInfo(state.model, usage);
  await recordUsageIfPossible(deps, input.projectName, state.model, usageInfo);
  yield { usage: usageInfo, done: true };
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

interface AccumulatedCall {
  id: string;
  name: string;
  arguments: string;
}

/** Accumulates streaming tool-call fragments by their delta index. */
class ToolCallAccumulator {
  private readonly byIndex = new Map<number, AccumulatedCall>();
  private readonly order: number[] = [];

  /**
   * @param usedIds ids already spoken for. Shared across a run's turns so a
   * synthesized id is unique in the whole conversation the run appends to, not
   * just in one response.
   */
  constructor(private readonly usedIds: Set<string> = new Set()) {}

  add(toolCall: ChannelToolCall): void {
    const index = toolCall.index ?? 0;
    let entry = this.byIndex.get(index);
    if (!entry) {
      entry = { id: toolCall.id ?? "", name: toolCall.function?.name ?? "", arguments: "" };
      this.byIndex.set(index, entry);
      this.order.push(index);
    }
    if (toolCall.id) {
      entry.id = toolCall.id;
    }
    if (toolCall.function?.name) {
      entry.name = toolCall.function.name;
    }
    if (toolCall.function?.arguments) {
      entry.arguments += toolCall.function.arguments;
    }
  }

  /**
   * The response's calls in delta order, each carrying an id unique across the
   * run. Dispatch keys results by id, so a provider that omits ids (some
   * OpenAI-compatible gateways do) or repeats one would otherwise have a call
   * served another call's result. Uniqueness spans the run rather than the one
   * response because the assistant message a chat persists carries *every*
   * turn's calls: two turns that both synthesized `call_1` would leave that
   * message with duplicate `tool_call_id`s, which the next request is rejected
   * for.
   */
  finalize(): AccumulatedCall[] {
    const calls: AccumulatedCall[] = [];
    for (const index of this.order) {
      const entry = this.byIndex.get(index);
      if (!entry || !entry.name) {
        continue;
      }
      let id = entry.id;
      for (let suffix = this.usedIds.size + 1; !id || this.usedIds.has(id); suffix += 1) {
        id = `call_${suffix}`;
      }
      this.usedIds.add(id);
      calls.push(id === entry.id ? entry : { ...entry, id });
    }
    return calls;
  }
}

function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function toWireToolCall(id: string, name: string, args: Record<string, unknown>): ChannelToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function subagentContextMessage(agentName: string, text: string): string {
  return `For context: the '${agentName}' agent responded with:\n${text}`;
}

/**
 * Conversation text one transfer may carry. A chain re-sends it at every hop,
 * so it is bounded far below the history budget a top-level run works with.
 */
const MAX_TRANSFER_CONTEXT_CHARS = 8_000;
/**
 * Below this, a truncated turn says nothing useful and is worse than admitting
 * it was omitted — the child reads half a sentence as if it were the whole one.
 */
const MIN_TRANSFER_LINE_CHARS = 500;

/** The readable text of one message; image parts are named, not inlined. */
function messageText(content: ChatMessageInput["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => (part.type === "text" ? part.text : "[image]"))
    .join(" ")
    .trim();
}

/**
 * The conversation so far, as text a transferred agent can read.
 *
 * Deliberately NOT replayed as messages. A child is a different agent with its
 * own system prompt: handed the parent's `assistant` turns it reads them as its
 * own ("as I already said"), and the parent's `tool_calls` would arrive naming
 * tools the child never declared. A labelled block inside the child's single
 * user turn has neither problem, and it is the one form a remote/A2A child —
 * which can only be sent text — can receive too.
 *
 * Spent newest-first, because a follow-up is usually about the turn just before
 * it, then flipped back into reading order.
 *
 * The turn being answered is excluded: the transfer message the model wrote is
 * already this request, so including it would hand the child the same thing
 * twice — and a conversation of one turn would carry a "conversation so far"
 * that is only itself. What remains is what the request cannot say on its own.
 */
export function buildTransferTranscript(
  messages: ChatMessageInput[],
  assistantLabel: string,
): { text: string; dropped: number } {
  const lines: string[] = [];
  let budget = MAX_TRANSFER_CONTEXT_CHARS;
  let dropped = 0;
  const prior = messages.at(-1)?.role === "user" ? messages.length - 1 : messages.length;
  for (let i = prior - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || (message.role !== "user" && message.role !== "assistant")) {
      continue;
    }
    const text = messageText(message.content);
    if (!text) {
      continue;
    }
    const line = `${message.role === "user" ? "User" : assistantLabel}: ${text}`;
    if (line.length > budget) {
      // One turn larger than the whole remaining budget. Dropping it outright
      // loses the *question* along with whatever made it long — a turn carrying
      // an attached document is a single line of tens of thousands of
      // characters, so every such turn used to evict itself entirely and the
      // child never learned the conversation was about a document at all.
      // Keeping its head keeps what the turn was about; the budget is spent
      // either way, so nothing older fits after this.
      if (budget > MIN_TRANSFER_LINE_CHARS) {
        lines.push(`${cutCodePoints(line, budget)}…[truncated]`);
        budget = 0;
      }
      dropped += 1;
      continue;
    }
    budget -= line.length;
    lines.push(line);
  }
  if (lines.length === 0) {
    return { text: "", dropped };
  }
  lines.reverse();
  // Said in the transcript itself, not only in the run's warnings: the child
  // never sees those, and a gap it cannot see is one it will answer around.
  if (dropped > 0) {
    lines.unshift(`…(${dropped} earlier turn(s) omitted)`);
  }
  return { text: lines.join("\n"), dropped };
}

/**
 * `a`, `a and b`, `a, b, and c`. Used to build the sentences below from the
 * capabilities a run actually resolved, so neither the routing rule nor the
 * image empty state ever names something this run cannot reach.
 */
function joinClauses(items: string[], conjunction: string): string {
  if (items.length <= 1) {
    return items[0] ?? "";
  }
  const last = items[items.length - 1] ?? "";
  const head = items.slice(0, -1);
  return items.length === 2
    ? `${head[0] ?? ""} ${conjunction} ${last}`
    : `${head.join(", ")}, ${conjunction} ${last}`;
}

/**
 * The boundary between the version's own prompt and what the engine appends.
 *
 * The sections below are generated per run and use `##` headings, which are
 * indistinguishable from headings the prompt author wrote — so the split is
 * marked explicitly. It also gives the routing rule a referent: "your
 * instructions" is everything above this line, and nothing else.
 */
function capabilityFraming(
  withSkills: boolean,
  withMcp: boolean,
  withSubagents: boolean,
): string {
  // Stated once, here. Each section below documents only what is specific to
  // it; three sections that each also said "use me when…" would leave the model
  // with unranked policies and no way to choose between them.
  const rules = [
    ...(withSkills ? ["load a skill when you need guidance on how to carry it out"] : []),
    ...(withMcp
      ? ["call a tool when you need data or an action from outside this conversation"]
      : []),
    ...(withSubagents
      ? ["transfer to an agent whose description covers the request better than your instructions do"]
      : []),
  ];
  const lines = [
    "# Runtime capabilities",
    "",
    "The instructions above define your role. This section is generated for this run and lists only what you can actually reach right now — treat it, not your instructions, as the truth about what is available.",
  ];
  if (rules.length > 0) {
    lines.push(
      "",
      `Your instructions define your role and constraints. Within that role, ${joinClauses(rules, "or")}.`,
    );
  }
  return lines.join("\n");
}

function skillSystemPromptAddition(skills: SkillInfo[]): string {
  const rows = skills
    .map((s) => `| ${s.name} | ${tableCell(s.description) || "No description"} |`)
    .join("\n");
  // No usage line: when to load one is the framing's job and which one to load
  // is the description's, while reaching a file inside a skill is documented on
  // the tool's own `file_path` parameter, which the model reads anyway.
  return [
    "## Available Skills",
    "",
    "| Skill | Description |",
    "|-------|-------------|",
    rows,
  ].join("\n");
}

/** One markdown table cell: a newline or a pipe in the value would break the row. */
function tableCell(value: string): string {
  return value.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();
}

function mcpSystemPromptAddition(servers: McpServerInfo[]): string {
  const rows = servers
    .map((s) => `| ${s.name} | ${tableCell(s.description)} | ${s.toolNames.join(", ")} |`)
    .join("\n");
  // Says what the table *is*; when to reach for it is the framing's job.
  return [
    "## Connected MCP Servers",
    "",
    "These tools come from external MCP servers.",
    "",
    "| Server | Description | Tools |",
    "|--------|-------------|-------|",
    rows,
  ].join("\n");
}

/**
 * Shaped like the skill and MCP sections: same heading level, same table, same
 * `tableCell` escaping, so a description that spans lines or carries a pipe
 * cannot end the section early and swallow the agents listed after it.
 *
 * The set of names is not restated in prose: `transfer_to_agent`'s `agent_name`
 * is an enum, which constrains the call itself rather than asking for it.
 */
function subagentSystemPromptAddition(subagents: SubagentInfo[], withDispatch: boolean): string {
  const rows = subagents
    .map(
      (a) =>
        `| ${a.name} | ${a.type} | ${tableCell(a.description) || "No description"} |`,
    )
    .join("\n");
  // Only the constraints the framing cannot state. "Background" is deliberate
  // and not "context you can rely on": the conversation rides along for an
  // agent or prompt child, but an image child is handed the `message` alone
  // (it is that child's image prompt), and the engine cannot tell them apart
  // from here — so the request itself always has to be complete.
  const lines = [
    "## Available Agents",
    "",
    "`message` is the whole of the request: the other agent does not see your instructions, so say what it should do. Recent conversation may be passed as background depending on the agent type, but `message` must always be self-contained. Once it has answered, do not transfer to it again for the same request.",
  ];
  if (withDispatch) {
    // Which of the two tools fits is specific to this section, like everything
    // else stated here — it is a fact about these agents, not a routing rule,
    // so it does not belong in the framing.
    lines.push(
      "",
      `Parts that do not depend on each other go to \`${DISPATCH_TOOL_NAME}\` in **one** call, so they run at the same time. A single request goes to \`${TRANSFER_TOOL_NAME}\`.`,
    );
  }
  lines.push("", "| Agent | Type | Description |", "|-------|------|-------------|", rows);
  return lines.join("\n");
}

function skillToolDef(skills: SkillInfo[]): ChannelToolDef {
  return {
    type: "function",
    function: {
      name: SKILL_TOOL_NAME,
      description:
        "Load the content of a connected skill. Returns the skill's main content (SKILL.md) or a specific file within the skill.",
      parameters: {
        type: "object",
        properties: {
          skill_name: {
            type: "string",
            // Enumerated like the transfer tool's `agent_name`: a free-text name
            // is the main source of "skill is not connected" round trips.
            enum: skills.map((s) => s.name),
            description: "The name of the skill to load.",
          },
          file_path: {
            type: "string",
            description:
              "Optional. Path to a specific file within the skill (e.g., 'references/REFERENCE.md').",
          },
        },
        required: ["skill_name"],
      },
    },
  };
}

function transferToolDef(subagents: SubagentInfo[], withImages: boolean): ChannelToolDef {
  return {
    type: "function",
    function: {
      name: TRANSFER_TOOL_NAME,
      description: "Transfer a specific message to another connected agent.",
      parameters: {
        type: "object",
        properties: {
          agent_name: {
            type: "string",
            enum: subagents.map((a) => a.name),
            description: "The agent name to transfer to.",
          },
          message: {
            type: "string",
            description: "The full message to send to the target agent.",
          },
          ...(withImages
            ? {
                image_ids: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Ids of images to hand over (see Available Images). Pass these when a local agent must edit or look at an existing image instead of making one up. Remote agents cannot receive images.",
                },
              }
            : {}),
        },
        required: ["agent_name", "message"],
      },
    },
  };
}

/**
 * Fan-out, where {@link transferToolDef} is handoff.
 *
 * Two tools rather than one widened tool. A call that runs several agents is a
 * different shape from one that hands the request to a single agent: the array
 * is what lets the model say "these do not depend on each other", and because it
 * is one call, the whole group keeps its place in call order and its answers
 * land in one tool result — spent from the same turn budget as every other tool
 * result rather than appended to the context with no budget at all.
 */
function dispatchToolDef(subagents: SubagentInfo[], withImages: boolean): ChannelToolDef {
  return {
    type: "function",
    function: {
      name: DISPATCH_TOOL_NAME,
      description: `Run several connected agents at the same time and collect their answers. Use this instead of ${TRANSFER_TOOL_NAME} when the request splits into parts that do not depend on each other. At most ${MAX_DISPATCH_TASKS} agents per call.`,
      parameters: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            minItems: 1,
            maxItems: MAX_DISPATCH_TASKS,
            description:
              "One entry per agent. They run concurrently, so no entry may depend on another's answer — dependent work belongs in a later turn.",
            items: {
              type: "object",
              properties: {
                agent_name: {
                  type: "string",
                  enum: subagents.map((a) => a.name),
                  description: "The agent to run.",
                },
                message: {
                  type: "string",
                  description:
                    "The full message for this agent. It sees neither your instructions nor the other tasks.",
                },
                ...(withImages
                  ? {
                      image_ids: {
                        type: "array",
                        items: { type: "string" },
                        description:
                          "Ids of images to hand to this local agent (see Available Images). Remote agents cannot receive images.",
                      },
                    }
                  : {}),
              },
              required: ["agent_name", "message"],
            },
          },
        },
        required: ["tasks"],
      },
    },
  };
}

function imageSystemPromptAddition(
  handles: readonly ImageHandle[],
  uses: { canEdit: boolean; canTransfer: boolean },
  withMcpTools: boolean,
): string {
  // Listed even when empty: the image tools' only documentation is a pointer to
  // this section, so it has to exist before the first picture does. The empty
  // state names only the routes an id can actually arrive by — the image tools
  // are offered together, so a run that cannot edit cannot generate either, and
  // a run with no MCP tools has nothing that could return a picture. Promising
  // an id from a source this run does not have is the same defect as listing a
  // skill that can never load.
  const arrivals = [
    ...(uses.canEdit ? ["from what you generate or edit"] : []),
    ...(withMcpTools ? ["from what a tool returns"] : []),
    "from what the user sends",
  ];
  const emptyState = `No images yet. Ids appear here as images arrive — ${joinClauses(arrivals, "and")}.`;
  const table =
    handles.length > 0
      ? [
          "| Image | Source |",
          "|-------|--------|",
          ...handles.map((h) => `| ${h.id} | ${tableCell(h.origin)} |`),
        ]
      : [emptyState];
  const howTo: string[] = [];
  if (uses.canEdit) {
    howTo.push(
      `Pass an id to the \`${EDIT_IMAGE_TOOL_NAME}\` tool to change that image. An image you generate later also gets an id, reported in the ${IMAGE_TOOL_NAME} result.`,
    );
  }
  if (uses.canTransfer) {
    howTo.push(
      `Pass ids as \`image_ids\` on \`${TRANSFER_TOOL_NAME}\`, or on each \`${DISPATCH_TOOL_NAME}\` task, so a local agent receives the actual picture instead of a description of it. Remote agents cannot receive images.`,
    );
  }
  return ["## Available Images", "", ...howTo.flatMap((line) => [line, ""]), ...table].join("\n");
}

/**
 * The system prompt an agent run actually sends: the version's own text, then a
 * marked block of the sections the engine appends for what this run can reach.
 * Exported for the Playground preview — the assembled prompt is what a reader
 * needs to see, and a second implementation of it would drift.
 *
 * A run that reaches nothing gets the version's text unchanged: framing an
 * empty capability block would announce a boundary with nothing behind it.
 */
/**
 * The version's own text, then everything the engine appends, behind one `---`.
 *
 * Single owner of that boundary. Both prompt assemblies — the agent's and the
 * single-shot one — append to an author's text, and a second copy of the rule
 * would drift the moment one of them grew a block the other did not have.
 *
 * A thematic break, not a heading: it separates without competing with the
 * author's own headings, and the blank line `join` adds keeps it from being read
 * as a setext underline for the line above. No blocks returns the author's text
 * byte-for-byte — a boundary is never announced with nothing behind it.
 */
function withEngineBlocks(base: string | undefined, blocks: string[]): string {
  if (blocks.length === 0) {
    return base ?? "";
  }
  const parts: string[] = [];
  if (base) {
    parts.push(base, "---");
  }
  parts.push(...blocks);
  return parts.join("\n\n");
}

/**
 * Stated as a fact, not as a `##` section: it is one line, and a heading would
 * compete with the capability sections while carrying a fraction of their
 * content. The instruction is what makes it useful — a model that is told the
 * date still answers "last week" from its training data unless it is told to
 * resolve relative dates from this line.
 */
function runClockBlock(now: Date): string {
  return `Current date and time: ${formatRunClock(now)}. Resolve anything relative — "today", "yesterday", "last week", "this quarter" — from this line rather than from what you remember.`;
}

/**
 * Who this run is answering, when the surface knows and the version asked for it.
 *
 * A fact about the run in the same sense the clock is: the model is told, it
 * cannot go looking. Without it a Slack thread reaches the model as anonymous
 * text and the answer cannot address anybody — which is what a conversational
 * agent is for.
 *
 * The avatar is a URL rather than an image part: a face is almost never what the
 * question is about, and encoding one would spend a turn's image budget on it.
 */
function callerBlock(caller: RunCaller): string {
  const lines = [`You are answering ${caller.displayName}.`];
  if (caller.timezone) {
    lines.push(`Their timezone is ${caller.timezone}; resolve their relative times in it.`);
  }
  if (caller.avatarUrl) {
    lines.push(`Their avatar: ${caller.avatarUrl}`);
  }
  return lines.join(" ");
}

export function buildAgentSystemPrompt(
  base: string | undefined,
  skills: SkillInfo[],
  subagents: SubagentInfo[],
  mcpServers: McpServerInfo[],
  images: { handles: readonly ImageHandle[]; canEdit: boolean; canTransfer: boolean },
  /** See {@link RunPromptInput.now}. Omitted keeps the prompt clock-free. */
  now?: Date,
  /** Whether this run is offered `dispatch_agents` (see {@link buildAgentTools}). */
  canDispatch = false,
  /** See {@link RunPromptInput.caller}. Omitted keeps the prompt anonymous. */
  caller?: RunCaller,
): string {
  const withMcp = mcpServers.length > 0;
  const sections: string[] = [];
  if (skills.length > 0) {
    sections.push(skillSystemPromptAddition(skills));
  }
  if (withMcp) {
    sections.push(mcpSystemPromptAddition(mcpServers));
  }
  if (subagents.length > 0) {
    sections.push(subagentSystemPromptAddition(subagents, canDispatch));
  }
  if (images.canEdit || images.canTransfer) {
    sections.push(imageSystemPromptAddition(images.handles, images, withMcp));
  }
  const blocks: string[] = [];
  // Ahead of the capability block, and outside it: the clock and the caller are
  // facts about when the run happens and who it answers, not things the run can
  // reach, and the framing below speaks only for the sections that follow it.
  if (now) {
    blocks.push(runClockBlock(now));
  }
  if (caller) {
    blocks.push(callerBlock(caller));
  }
  if (sections.length > 0) {
    blocks.push(capabilityFraming(skills.length > 0, withMcp, subagents.length > 0), ...sections);
  }
  return withEngineBlocks(base, blocks);
}

const IMAGE_TOOL_DEF: ChannelToolDef = {
  type: "function",
  function: {
    name: IMAGE_TOOL_NAME,
    description:
      "Generate an image from a detailed English prompt. Use when the user asks to draw, create, or generate a picture. The image is delivered to the user automatically — do not describe it as unavailable.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Detailed English image prompt (subject, style, composition, lighting).",
        },
        size: {
          type: "string",
          enum: ["1024x1024", "1536x1024", "1024x1536"],
          description: "Image dimensions; default 1024x1024.",
        },
        quality: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Rendering quality; default medium.",
        },
      },
      required: ["prompt"],
    },
  },
};

const EDIT_IMAGE_TOOL_DEF: ChannelToolDef = {
  type: "function",
  function: {
    name: EDIT_IMAGE_TOOL_NAME,
    description:
      "Edit an existing image: change, add or remove something in it, or restyle it. Address the image by its id (see Available Images, and the ids reported by GenerateImage). The edited image is delivered to the user automatically.",
    parameters: {
      type: "object",
      properties: {
        image_id: {
          type: "string",
          description: "Id of the image to edit, e.g. 'img_1'.",
        },
        prompt: {
          type: "string",
          description:
            "Detailed English instruction describing the edited result, not just the change.",
        },
        size: {
          type: "string",
          enum: ["1024x1024", "1536x1024", "1024x1536"],
          description: "Output dimensions; default 1024x1024.",
        },
        quality: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Rendering quality; default medium.",
        },
      },
      required: ["image_id", "prompt"],
    },
  },
};

/**
 * The tool set an agent run declares, and the builtin names it claimed.
 * Exported for the Playground preview, which reports the names the model will
 * actually be offered — deriving them a second time would drift from the
 * offered/intercepted contract this function owns.
 */
export function buildAgentTools(
  mcpTools: ChannelToolDef[] | undefined,
  skills: SkillInfo[],
  subagents: SubagentInfo[],
  withImageTool: boolean,
  withEditTool: boolean,
  withImageTransfer: boolean,
  /**
   * Whether fan-out is offered. False for a subagent run: a child that could
   * dispatch would multiply the run count by depth, and these children run
   * outside the concurrency and cost guards (see {@link MAX_DISPATCH_TASKS}).
   */
  canDispatch = false,
): { tools: ChannelToolDef[]; builtinNames: Set<string> } {
  const tools: ChannelToolDef[] = [...(mcpTools ?? [])];
  // The names of the builtins actually offered. The tool loop intercepts a call
  // only when its name is in here, so "offered" and "intercepted" cannot drift
  // apart — an MCP tool named like an inactive builtin stays reachable.
  const builtinNames = new Set<string>();
  if (skills.length > 0) {
    tools.push(skillToolDef(skills));
    builtinNames.add(SKILL_TOOL_NAME);
  }
  if (subagents.length > 0) {
    tools.push(transferToolDef(subagents, withImageTransfer));
    builtinNames.add(TRANSFER_TOOL_NAME);
    if (canDispatch) {
      tools.push(dispatchToolDef(subagents, withImageTransfer));
      builtinNames.add(DISPATCH_TOOL_NAME);
    }
  }
  if (withImageTool) {
    tools.push(IMAGE_TOOL_DEF);
    builtinNames.add(IMAGE_TOOL_NAME);
  }
  if (withEditTool) {
    tools.push(EDIT_IMAGE_TOOL_DEF);
    builtinNames.add(EDIT_IMAGE_TOOL_NAME);
  }
  return { tools, builtinNames };
}

/**
 * What a run can do with an image, which is what decides whether the system
 * prompt carries an `## Available Images` section and whether the image tools
 * are offered. Derived from the deps rather than the version, so the preview
 * and the run cannot disagree about a section's presence.
 */
export function imagePromptUses(
  deps: Pick<AgentDeps, "editImage" | "runSubagent">,
  subagents: SubagentInfo[],
): { canEdit: boolean; canTransfer: boolean } {
  return {
    canEdit: Boolean(deps.editImage),
    canTransfer: subagents.some((agent) => agent.type === "local") && Boolean(deps.runSubagent),
  };
}

async function loadSkillSafe(
  loader: (skillName: string, filePath?: string) => Promise<string>,
  skills: SkillInfo[],
  skillName: string,
  filePath: string | undefined,
): Promise<string> {
  const names = skills.map((s) => s.name);
  if (!names.includes(skillName)) {
    return `Error: Skill '${skillName}' is not connected to this agent. Available skills: ${names.join(", ")}`;
  }
  try {
    return await loader(skillName, filePath);
  } catch (error) {
    return `Error: Failed to load skill '${skillName}'. ${errorMessage(error)}`;
  }
}

export async function* runAgent(
  deps: AgentDeps,
  input: RunAgentInput,
): AsyncGenerator<EngineChunk> {
  const withImages = assertImageInputAllowed(input.model, input.messages);
  let fallbackModel = imageEligibleFallback(input.fallbackModel, withImages);
  const maxTurn = input.maxTurn ?? DEFAULT_MAX_TURN;
  // Whether a picture an MCP tool returns can enter this run's context at all.
  const imageInputReject = describeImageInputReject(input.model);
  const skills = input.skills ?? [];
  const subagents = input.subagents ?? [];
  // Top-level chunks stay unauthored: "no author" is the contract every
  // consumer uses to pick out the visible answer. Subagent chunks are the only
  // authored ones — the runSubagent wrapper stamps the subagent's name.
  const author = undefined;

  // Handles are worth keeping when something can act on them: this run can edit
  // an image, or it can hand one to another agent that will.
  const { canEdit, canTransfer } = imagePromptUses(deps, subagents);
  const images = new ImageRegistry();
  if (canEdit || canTransfer) {
    registerInputImages(images, input.messages);
  }
  // Fan-out is offered only where it can actually reach a child: the facade said
  // this is a top-level run, and there is a runner to dispatch to.
  const canDispatch = Boolean(input.canDispatch && deps.runSubagent);
  const systemPrompt = buildAgentSystemPrompt(
    input.systemPrompt,
    skills,
    subagents,
    input.mcpServers ?? [],
    { handles: images.list(), canEdit, canTransfer },
    input.now,
    canDispatch,
    input.caller,
  );
  const { tools, builtinNames } = buildAgentTools(
    input.mcpTools,
    skills,
    subagents,
    Boolean(deps.generateImage),
    canEdit,
    canTransfer,
    canDispatch,
  );
  const filter = input.parameters?.piiFiltering ? new PiiFilter() : undefined;

  // Derived once, from the messages the run was handed rather than the array
  // below: that one keeps growing with this run's own tool traffic and the
  // synthesized "For context" turns, none of which is the conversation the user
  // had. Masked here so a child never receives PII the parent's own context is
  // protected from. An inherited transcript is already both.
  const derivedTranscript =
    input.transcript === undefined && subagents.length > 0
      ? buildTransferTranscript(input.messages, input.projectName)
      : undefined;
  const transcript =
    input.transcript ??
    (derivedTranscript?.text
      ? (filter?.mask(derivedTranscript.text) ?? derivedTranscript.text)
      : undefined);
  let transcriptTruncationReported = (derivedTranscript?.dropped ?? 0) === 0;

  const messages: ChannelMessage[] = [];
  if (systemPrompt) {
    messages.push({
      role: "system",
      content: filter?.mask(systemPrompt) ?? systemPrompt,
    });
  }
  messages.push(
    ...(filter ? input.messages.map((message) => maskMessage(filter, message)) : input.messages),
  );

  // One ceiling for everything this run accumulates, derived from the model's
  // own context window (min with the configured fallback's — a mid-run switch
  // must still fit). The input and the declared tools are charged up front;
  // everything the loop adds is charged — or cut to fit, with a report — as it
  // enters. A run with headroom is byte-identical to an unbudgeted one.
  const contextBudget = createRunContextBudget(
    input.model,
    input.fallbackModel,
    input.parameters?.maxTokens,
  );
  if (contextBudget) {
    for (const message of messages) {
      contextBudget.chargeMessage(message);
    }
    if (tools.length > 0) {
      contextBudget.chargeText(JSON.stringify(tools));
    }
  }
  // Reported once, at the first cut: a run that never fills the budget should
  // never mention it.
  let contextTruncationReported = false;

  let turn = input.startTurn ?? 0;
  // Ids already spoken for, across every turn: what the assistant message a
  // chat persists must not repeat.
  const usedCallIds = new Set<string>();
  /**
   * Whether a previous turn already said something visible.
   *
   * A tool-using run speaks more than once — "let me look that up", tools, then
   * the answer — and every consumer flattens those turns into one string by
   * appending deltas. Within a turn that is right, it is how streaming works;
   * across turns it ran the last sentence of one into the first word of the
   * next: `…확인해볼게요."demo" 데이터소스를 찾았어요.`
   *
   * The break belongs here rather than in each consumer. Chat, Slack and the
   * OpenAI-compatible response all did the same concatenation, and a boundary
   * only the producer knows about is not something three of them should each
   * re-derive.
   */
  let saidSomething = false;
  while (true) {
    if (turn >= maxTurn) {
      // The turn guard is the largest thing a run can lose — its own ending —
      // so it is the one ending that must not be silent: the warning tells the
      // user why there is no answer, and the termination chunk tells consumers
      // why the stream ended instead of leaving them to infer it from the
      // absence of `done`.
      yield {
        author,
        warning: `The run stopped at its turn limit (${maxTurn} turns) before the model finished answering.`,
      };
      yield { author, finishReason: "turn-limit" };
      return;
    }

    input.signal?.throwIfAborted();
    const params = buildChannelParams(input.model, messages, input.parameters, tools, input.signal);
    const state = { model: input.model };
    let assistantText = "";
    let reasoningText = "";
    let usage: ChannelUsage | null = null;
    const accumulator = new ToolCallAccumulator(usedCallIds);
    const contentRestorer = filter?.createStreamRestorer();
    const reasoningRestorer = filter?.createStreamRestorer();

    try {
      for await (const chunk of streamWithFallback(deps.channel, params, fallbackModel, state)) {
        if (chunk.usage) {
          usage = chunk.usage;
        }
        const delta = chunk.choices[0]?.delta;
        if (!delta) {
          continue;
        }
        // Independent checks, not a chain. The three delta fields are
        // concurrent accumulation buffers on the wire, not mutually exclusive
        // events: OpenAI-compatible gateways (vLLM, LiteLLM) and reasoning
        // shims routinely emit content or reasoning_content alongside
        // tool_calls in one delta, and an `else if` would silently drop the
        // tool call — the loop would then finish as if the model never asked.
        if (delta.content) {
          // First visible word of a turn that follows one which already spoke:
          // separate them. `assistantText` is this turn's own buffer, so it is
          // empty exactly once per turn, and a turn that only calls tools never
          // reaches here — no stray break before an answer that follows silence.
          if (assistantText === "" && saidSomething) {
            yield { author, delta: { content: TURN_SEPARATOR } };
          }
          assistantText += delta.content;
          const content = contentRestorer?.push(delta.content) ?? delta.content;
          if (content) {
            saidSomething = true;
            yield { author, delta: { content } };
          }
        }
        if (delta.reasoning_content) {
          reasoningText += delta.reasoning_content;
          const reasoningContent =
            reasoningRestorer?.push(delta.reasoning_content) ?? delta.reasoning_content;
          if (reasoningContent) {
            yield { author, delta: { reasoningContent } };
          }
        }
        if (delta.tool_calls) {
          for (const toolCall of delta.tool_calls) {
            accumulator.add(toolCall);
          }
        }
      }
    } catch (error) {
      input.signal?.throwIfAborted();
      const remainingContent = contentRestorer?.flush();
      if (remainingContent) {
        yield { author, delta: { content: remainingContent } };
      }
      const remainingReasoning = reasoningRestorer?.flush();
      if (remainingReasoning) {
        yield { author, delta: { reasoningContent: remainingReasoning } };
      }
      yield { author, error: errorMessage(error) };
      return;
    }

    const remainingContent = contentRestorer?.flush();
    if (remainingContent) {
      yield { author, delta: { content: remainingContent } };
    }
    const remainingReasoning = reasoningRestorer?.flush();
    if (remainingReasoning) {
      yield { author, delta: { reasoningContent: remainingReasoning } };
    }

    const usageInfo = toUsageInfo(state.model, usage);
    await recordUsageIfPossible(deps, input.projectName, state.model, usageInfo);
    yield { author, usage: usageInfo };

    const calls = accumulator.finalize();
    if (calls.length === 0) {
      yield { author, done: true };
      return;
    }

    // All tool calls of one response aggregate into ONE assistant message.
    const wireToolCalls: ChannelToolCall[] = [];
    const toolMessages: ChannelMessage[] = [];
    const postContextMessages: ChannelMessage[] = [];
    /** Pictures MCP tools returned this turn, attached after the tool results. */
    const attachedImages: Array<{ b64: string; mimeType: string }> = [];
    // One turn's worth of pictures an MCP tool may add to the context, sharing
    // the cap a user turn gets — they cost the same and arrive the same way.
    // Per turn, not per run: the cap bounds one request, and spending it once
    // would leave a screenshot agent blind for the rest of the run.
    let imageBudget = MAX_ATTACHMENTS;
    let nextTurn = turn + 1;

    // Announce every call before any of them runs: the client sees the whole
    // plan at once, and the MCP calls below can overlap.
    // `builtin` is decided by the offered set, not by the dep — an MCP tool that
    // arrived under a builtin's name is only shadowed when that builtin is offered.
    const prepared = calls.map((call) => {
      const args = parseToolArguments(call.arguments);
      const displayArgs = filter
        ? (restoreValues(filter, args) as Record<string, unknown>)
        : args;
      return { call, args, displayArgs, builtin: builtinNames.has(call.name) };
    });
    for (const { call, args, displayArgs } of prepared) {
      wireToolCalls.push(toWireToolCall(call.id, call.name, args));
      yield { author, delta: { toolCalls: [toWireToolCall(call.id, call.name, displayArgs)] } };
    }

    // The MCP calls of one response are independent by construction — the model
    // asked for them together — so they run concurrently instead of adding up
    // their latencies. Builtins stay strictly in call order below: a transfer
    // moves the turn budget and the image tools mutate the image registry.
    // Failures are settled rather than thrown, so one rejection cannot leave the
    // other in-flight calls' rejections unhandled; each is rethrown in order.
    const mcpDispatch = deps.callMcpTool;
    const mcpCalls = mcpDispatch ? prepared.filter((entry) => !entry.builtin) : [];
    const mcpSettled = new Map<string, { ok: McpToolResult } | { err: unknown }>();
    if (mcpDispatch && mcpCalls.length > 0) {
      const settled = await mapWithLimit(mcpCalls, MAX_PARALLEL_TOOL_CALLS, async (entry) => {
        try {
          return { ok: await mcpDispatch(entry.call.name, entry.displayArgs) };
        } catch (err) {
          return { err };
        }
      });
      mcpCalls.forEach((entry, index) => {
        const result = settled[index];
        if (result) {
          mcpSettled.set(entry.call.id, result);
        }
      });
    }

    const spendResultBudget = createToolResultBudget(MAX_TOOL_RESULT_CHARS_PER_TURN, contextBudget);

    for (const { call, args, displayArgs, builtin } of prepared) {
      if (builtin && call.name === TRANSFER_TOOL_NAME) {
        // Child runs at turn+1 and the parent resumes at turn+2, so two turns
        // must remain or the resume would trip the initial guard.
        if (turn + 2 >= maxTurn) {
          const errorText = "Error: Agent max_turn reached before transfer.";
          yield { author, toolResult: { toolCallId: call.id, name: call.name, content: errorText } };
          toolMessages.push({ role: "tool", tool_call_id: call.id, content: errorText });
          continue;
        }
        const agentName = typeof args.agent_name === "string" ? args.agent_name : "";
        const message = typeof args.message === "string" ? args.message : "";
        if (!agentName || !message.trim() || !deps.runSubagent) {
          const errorText = "Error: transfer_to_agent requires agent_name and message.";
          yield { author, toolResult: { toolCallId: call.id, name: call.name, content: errorText } };
          toolMessages.push({ role: "tool", tool_call_id: call.id, content: errorText });
          continue;
        }
        // Named images travel as bytes, so the child edits the real picture
        // instead of a description of it.
        const requestedIds = Array.isArray(displayArgs.image_ids)
          ? displayArgs.image_ids.filter((id): id is string => typeof id === "string")
          : [];
        const handedOver = requestedIds.map((id) => images.get(id)).filter(Boolean) as ImageHandle[];
        if (handedOver.length < requestedIds.length) {
          const known = images.list().map((handle) => handle.id);
          const errorText = `Error: unknown image id in image_ids. Available images: ${known.length ? known.join(", ") : "none"}.`;
          yield { author, toolResult: { toolCallId: call.id, name: call.name, content: errorText } };
          toolMessages.push({ role: "tool", tool_call_id: call.id, content: errorText });
          continue;
        }
        const childImages = handedOver.map(({ b64, mimeType }) => ({ b64, mimeType }));
        // Reported the first time a transfer actually carries a clipped
        // transcript, not at run start: a run whose model never delegates lost
        // nothing, and saying otherwise trains readers to ignore the warning.
        if (!transcriptTruncationReported) {
          transcriptTruncationReported = true;
          yield {
            author,
            warning: `Earlier turns were left out of the context handed to other agents: a transfer carries at most ${MAX_TRANSFER_CONTEXT_CHARS} characters of this conversation.`,
          };
        }
        // The model-written message plus the conversation it refers to. The
        // runner decides where the transcript goes — a child's own kind governs
        // that — and the child's final text returns as a "For context" message.
        const childText = filter
          ? yield* runSubagentWithPii(
              filter,
              deps.runSubagent,
              agentName,
              message,
              turn + 1,
              maxTurn,
              childImages,
              transcript,
            )
          : yield* deps.runSubagent(
              agentName,
              message,
              turn + 1,
              maxTurn,
              childImages,
              transcript,
            );
        // A successful transfer used to leave no trace at all: only its failures
        // yielded a result, so a reader of the finished conversation could not
        // tell which agent had answered. Marked display-only — the child's
        // answer returns as its own message, and replaying this marker in its
        // place would say the delegation came back empty.
        yield {
          author,
          toolResult: {
            toolCallId: call.id,
            name: `${TRANSFER_TOOL_NAME}: ${agentName}`,
            content: `Transferred to '${agentName}'; its answer follows.`,
            displayOnly: true,
          },
        };
        toolMessages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ result: null }),
        });
        // A transfer's answer used to enter the context with no bound at all —
        // the one unbudgeted spot. The user already saw the child's full
        // answer stream by; only what re-enters the parent's context is cut.
        // The wrapper is charged first and the marker is reserved inside the
        // fit, so the whole message this pushes — wrapper, answer, marker —
        // is inside the budget, not riding on its headroom.
        contextBudget?.chargeText(subagentContextMessage(agentName, ""));
        const fittedChild = contextBudget?.fitText(childText, {
          suffix: "\n…[truncated: the run's context budget is exhausted]",
        }) ?? { text: childText, truncated: false, kept: true };
        let childAnswer = fittedChild.text;
        if (!fittedChild.kept) {
          childAnswer =
            "…[the agent's answer could not be included: the run's context budget is exhausted]";
          contextBudget?.chargeText(childAnswer);
        }
        postContextMessages.push({
          role: "user",
          content:
            filter?.mask(subagentContextMessage(agentName, childAnswer)) ??
            subagentContextMessage(agentName, childAnswer),
        });
        nextTurn = Math.max(nextTurn, turn + 2);
        continue;
      }

      if (builtin && call.name === DISPATCH_TOOL_NAME && deps.runSubagent) {
        const dispatchSubagent = deps.runSubagent;
        // A group costs the parent exactly what one transfer costs: the children
        // run at turn+1 and the parent resumes at turn+2 however many there were.
        if (turn + 2 >= maxTurn) {
          const errorText = `Error: Agent max_turn reached before ${DISPATCH_TOOL_NAME}.`;
          yield { author, toolResult: { toolCallId: call.id, name: call.name, content: errorText } };
          toolMessages.push({ role: "tool", tool_call_id: call.id, content: errorText });
          continue;
        }
        // From `args`, not `displayArgs`, for the same reason a transfer reads
        // `args.message`: a child is on the far side of the PII boundary and must
        // receive the **masked** text. `displayArgs` has the values restored — for
        // display and for MCP dispatch, where the real address is the point — and
        // handing that to another model would leak what the parent's own context
        // is protected from. Image ids are not PII patterns, so they read the same
        // either way and one source per task keeps this honest.
        const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
        if (rawTasks.length === 0) {
          const errorText = `Error: ${DISPATCH_TOOL_NAME} requires a non-empty tasks array; each task needs agent_name and message.`;
          yield { author, toolResult: { toolCallId: call.id, name: call.name, content: errorText } };
          toolMessages.push({ role: "tool", tool_call_id: call.id, content: errorText });
          continue;
        }
        // Validated per task, and one task that cannot run does not cancel the
        // others — its own section says why. Tasks past the width limit are
        // refused the same way rather than dropped: a silently shortened list
        // makes the model answer for work that never ran.
        const plans = rawTasks.map((raw, index): DispatchPlan => {
          const task = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
            string,
            unknown
          >;
          const agentName = typeof task.agent_name === "string" ? task.agent_name : "";
          const label = agentName || `task ${index + 1}`;
          if (index >= MAX_DISPATCH_TASKS) {
            return {
              agentName: label,
              failure: `Error: not run — at most ${MAX_DISPATCH_TASKS} agents per ${DISPATCH_TOOL_NAME} call. Ask for this one again.`,
            };
          }
          const message = typeof task.message === "string" ? task.message : "";
          if (!agentName || !message.trim()) {
            return {
              agentName: label,
              failure: "Error: each task needs agent_name and a non-empty message.",
            };
          }
          const requestedIds = Array.isArray(task.image_ids)
            ? task.image_ids.filter((id): id is string => typeof id === "string")
            : [];
          const handedOver = requestedIds
            .map((id) => images.get(id))
            .filter(Boolean) as ImageHandle[];
          if (handedOver.length < requestedIds.length) {
            const known = images.list().map((handle) => handle.id);
            return {
              agentName,
              failure: `Error: unknown image id in image_ids. Available images: ${known.length ? known.join(", ") : "none"}.`,
            };
          }
          return {
            agentName,
            message,
            childImages: handedOver.map(({ b64, mimeType }) => ({ b64, mimeType })),
          };
        });
        const runnable = plans.flatMap((plan, index) =>
          "failure" in plan ? [] : [{ plan, index, outcome: {} as { error?: string } }],
        );
        // Same clipped-transcript report a transfer makes, and for the same
        // reason: these children receive the same conversation.
        if (runnable.length > 0 && !transcriptTruncationReported) {
          transcriptTruncationReported = true;
          yield {
            author,
            warning: `Earlier turns were left out of the context handed to other agents: a transfer carries at most ${MAX_TRANSFER_CONTEXT_CHARS} characters of this conversation.`,
          };
        }
        // Every child advances at once; their chunks interleave, which is what
        // `author`/`authorPath` on a subagent chunk is for. The returned texts
        // come back at their own index, not in arrival order.
        const answers = yield* mergeGenerators(
          runnable.map(({ plan, outcome }) =>
            reportChildCompletion(
              observeChildFailure(
                filter
                  ? runSubagentWithPii(
                      filter,
                      dispatchSubagent,
                      plan.agentName,
                      plan.message,
                      turn + 1,
                      maxTurn,
                      plan.childImages,
                      transcript,
                    )
                  : dispatchSubagent(
                      plan.agentName,
                      plan.message,
                      turn + 1,
                      maxTurn,
                      plan.childImages,
                      transcript,
                    ),
                outcome,
              ),
              plan.agentName,
            ),
          ),
        );
        // Split evenly rather than spent in order: a first task that answers at
        // length would otherwise starve every task after it, which is the whole
        // point of having asked several at once.
        const perTask = Math.max(
          1,
          Math.floor(MAX_TOOL_RESULT_CHARS_PER_TURN / Math.max(1, runnable.length)),
        );
        const answerByIndex = new Map<number, { text: string; failed: boolean }>();
        runnable.forEach(({ index, outcome }, position) => {
          const answer = (answers[position] ?? "").trim();
          // The answer decides, not the error chunks that went past. A child whose
          // nested transfer failed still answers from that tool error, and a
          // descendant's failure surfaces on this same stream — treating either as
          // the task's outcome would throw away the answer it actually produced,
          // and one recovered failure per task would report the whole call failed.
          if (answer) {
            answerByIndex.set(index, {
              text: createToolResultBudget(perTask)(answer),
              failed: false,
            });
            return;
          }
          answerByIndex.set(index, {
            text: outcome.error
              ? `Error: ${outcome.error}`
              : "Error: the agent returned no answer.",
            failed: true,
          });
        });
        const sections = plans.map((plan, index) => ({
          agentName: plan.agentName,
          ...("failure" in plan
            ? { text: plan.failure, failed: true }
            : (answerByIndex.get(index) ?? {
                text: "Error: the agent did not run.",
                failed: true,
              })),
        }));
        // Prefixed `Error:` only when nothing succeeded. A partial failure is not
        // a failed call — the sections that answered are usable, and the trace
        // reads this prefix to decide whether the span failed.
        const body = sections
          .map((section) => `### ${section.agentName}\n${section.text}`)
          .join("\n\n");
        const dispatchText = sections.every((section) => section.failed)
          ? `Error: no agent in this ${DISPATCH_TOOL_NAME} call produced an answer.\n\n${body}`
          : body;
        // Through the turn budget like any other tool result, which is the reason
        // the answers come back here instead of as an unbudgeted context message.
        const spentText = spendResultBudget(dispatchText);
        const maskedDispatch = filter?.mask(spentText) ?? spentText;
        yield {
          author,
          toolResult: {
            toolCallId: call.id,
            name: call.name,
            content: filter?.restore(maskedDispatch) ?? spentText,
          },
        };
        toolMessages.push({ role: "tool", tool_call_id: call.id, content: maskedDispatch });
        nextTurn = Math.max(nextTurn, turn + 2);
        continue;
      }

      if (builtin && call.name === IMAGE_TOOL_NAME && deps.generateImage) {
        const maskedPrompt = typeof args.prompt === "string" ? args.prompt : "";
        const displayPrompt = typeof displayArgs.prompt === "string" ? displayArgs.prompt : "";
        const size = typeof displayArgs.size === "string" ? displayArgs.size : undefined;
        const quality = typeof displayArgs.quality === "string" ? displayArgs.quality : undefined;
        let resultText: string;
        if (!maskedPrompt.trim()) {
          resultText = "Error: GenerateImage requires a prompt.";
        } else {
          try {
            const image = await deps.generateImage(maskedPrompt, size, quality);
            yield { author, image: { ...image, prompt: displayPrompt } };
            const handle = deps.editImage
              ? images.add(image, `generated: ${displayPrompt.slice(0, 60)}`)
              : undefined;
            resultText = handle
              ? `Image generated and delivered to the user (image id: ${handle.id}, editable with ${EDIT_IMAGE_TOOL_NAME}). Briefly describe what was drawn; do not claim you cannot show images.`
              : "Image generated and delivered to the user. Briefly describe what was drawn; do not claim you cannot show images.";
          } catch (error) {
            input.signal?.throwIfAborted();
            resultText = `Error: image generation failed. ${errorMessage(error)}`;
          }
        }
        const maskedResultText = filter?.mask(resultText) ?? resultText;
        yield {
          author,
          toolResult: {
            toolCallId: call.id,
            name: call.name,
            content: filter?.restore(maskedResultText) ?? resultText,
          },
        };
        toolMessages.push({ role: "tool", tool_call_id: call.id, content: maskedResultText });
        continue;
      }

      if (builtin && call.name === EDIT_IMAGE_TOOL_NAME && deps.editImage) {
        const maskedPrompt = typeof args.prompt === "string" ? args.prompt : "";
        const displayPrompt = typeof displayArgs.prompt === "string" ? displayArgs.prompt : "";
        const imageId = typeof displayArgs.image_id === "string" ? displayArgs.image_id : "";
        const size = typeof displayArgs.size === "string" ? displayArgs.size : undefined;
        const quality = typeof displayArgs.quality === "string" ? displayArgs.quality : undefined;
        const source = images.get(imageId);
        let resultText: string;
        if (!maskedPrompt.trim()) {
          resultText = `Error: ${EDIT_IMAGE_TOOL_NAME} requires a prompt.`;
        } else if (!source) {
          const known = images.list().map((handle) => handle.id);
          resultText = known.length
            ? `Error: no image with id '${imageId}'. Available images: ${known.join(", ")}.`
            : `Error: no image is available to edit yet. Generate one first, or ask the user to attach one.`;
        } else {
          try {
            const image = await deps.editImage({
              prompt: maskedPrompt,
              images: [{ b64: source.b64, mimeType: source.mimeType }],
              size,
              quality,
            });
            yield { author, image: { ...image, prompt: displayPrompt } };
            const handle = images.add(image, `edited from ${source.id}`);
            resultText = `Image edited and delivered to the user (image id: ${handle.id}). Briefly describe the change; do not claim you cannot show images.`;
          } catch (error) {
            input.signal?.throwIfAborted();
            resultText = `Error: image edit failed. ${errorMessage(error)}`;
          }
        }
        const maskedEditText = filter?.mask(resultText) ?? resultText;
        yield {
          author,
          toolResult: {
            toolCallId: call.id,
            name: call.name,
            content: filter?.restore(maskedEditText) ?? resultText,
          },
        };
        toolMessages.push({ role: "tool", tool_call_id: call.id, content: maskedEditText });
        continue;
      }

      let content: string;
      let resultName = call.name;
      if (builtin && call.name === SKILL_TOOL_NAME && deps.loadSkillContent) {
        const skillName = typeof displayArgs.skill_name === "string" ? displayArgs.skill_name : "";
        const filePath =
          typeof displayArgs.file_path === "string" ? displayArgs.file_path : undefined;
        content = await loadSkillSafe(deps.loadSkillContent, skills, skillName, filePath);
        if (skillName) {
          resultName = `${SKILL_TOOL_NAME}: ${skillName}`;
        }
      } else {
        const settled = mcpSettled.get(call.id);
        if (!settled) {
          content = `Error: Tool '${call.name}' cannot be executed in this context.`;
        } else if ("err" in settled) {
          // Dispatched above; a thrown dispatcher still tears the run down here,
          // in call order, exactly as a sequential dispatch did.
          input.signal?.throwIfAborted();
          throw settled.err;
        } else {
          input.signal?.throwIfAborted();
          content = settled.ok.text;
          const produced = settled.ok.images ?? [];
          if (produced.length > 0 && imageInputReject) {
            // Sending parts this model rejects would fail the whole turn, so the
            // model is told the pictures existed instead of silently losing them.
            content += `\n\n(${produced.length} image(s) from this tool were dropped: ${imageInputReject})`;
          } else if (produced.length > 0) {
            const accepted = produced.slice(0, imageBudget);
            imageBudget -= accepted.length;
            const ids: string[] = [];
            for (const image of accepted) {
              // An id is only worth handing over when something can act on it.
              const handle = canEdit || canTransfer ? images.add(image, `returned by ${call.name}`) : undefined;
              if (handle) {
                ids.push(handle.id);
              }
              attachedImages.push(image);
              yield { author, image: { ...image, prompt: `Returned by ${call.name}` } };
            }
            if (accepted.length > 0) {
              // A tool message carries text only, so the bytes ride on the
              // follow-up user message appended after this turn's tool results.
              content += `\n\n${accepted.length} image(s) returned by this tool are attached to the next message${
                ids.length > 0 ? ` (image id${ids.length > 1 ? "s" : ""}: ${ids.join(", ")})` : ""
              }.`;
            }
            const dropped = produced.length - accepted.length;
            if (dropped > 0) {
              // Never "0 attached, 2 dropped": a turn whose budget is already
              // spent has nothing coming, and saying otherwise makes the model
              // answer about a picture it will never see.
              content +=
                accepted.length > 0
                  ? ` ${dropped} more were dropped: at most ${MAX_ATTACHMENTS} images per turn.`
                  : `\n\n${dropped} image(s) from this tool were dropped: this turn's limit of ${MAX_ATTACHMENTS} images is already spent.`;
            }
          }
        }
      }
      content = spendResultBudget(content);
      const maskedContent = filter?.mask(content) ?? content;
      yield {
        author,
        toolResult: {
          toolCallId: call.id,
          name: resultName,
          content: filter?.restore(maskedContent) ?? content,
        },
      };
      toolMessages.push({ role: "tool", tool_call_id: call.id, content: maskedContent });
    }

    // Reported once per run, on the turn the first cut happened: the model
    // already saw each cut in its result text, and this is the user's copy.
    if (contextBudget?.truncated() && !contextTruncationReported) {
      contextTruncationReported = true;
      yield {
        author,
        warning:
          "The run filled the model's context budget; further tool output and transferred answers are truncated to fit.",
      };
    }

    if (attachedImages.length > 0) {
      // A tool message is text-only, so the bytes enter as a user turn — the
      // same route a transfer's "For context" answer takes.
      const imagesMessage: ChannelMessage = {
        role: "user",
        content: [
          { type: "text", text: "Images returned by the tool calls above:" },
          ...attachedImages.map((image) => ({
            type: "image_url" as const,
            image_url: { url: imageDataUrl(image) },
          })),
        ],
      };
      // Charged at the flat per-image rate — the base64 url's length says
      // nothing about what the provider charges for an image.
      contextBudget?.chargeMessage(imagesMessage);
      postContextMessages.push(imagesMessage);
      // The context now carries images, so a fallback that cannot read them
      // would turn a retryable failure into a hard one.
      fallbackModel = imageEligibleFallback(fallbackModel, true);
    }

    const assistantMessage: ChannelMessage = {
      role: "assistant",
      content: assistantText || null,
      tool_calls: wireToolCalls,
    };
    if (reasoningText) {
      assistantMessage.reasoning_content = reasoningText;
    }
    // The model's own turn is context now too; the tool results — markers,
    // wrappers and omission strings included — were already charged as they
    // were fitted or inserted.
    contextBudget?.chargeMessage(assistantMessage);
    messages.push(assistantMessage, ...toolMessages, ...postContextMessages);
    turn = nextTurn;
  }
}
