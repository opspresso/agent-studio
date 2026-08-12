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
import { renderTemplate } from "@/shared/template";
import { formatRunClock } from "@/shared/date";
import { mergeGenerators } from "@/shared/mergeGenerators";
import { log } from "@/shared/logger";
import { cutCodePoints } from "@/shared/utf8Text";
import {
  assembleAgentRun,
  callerBlock,
  DISPATCH_TOOL_NAME,
  EDIT_IMAGE_TOOL_NAME,
  FETCH_URL_TOOL_NAME,
  IMAGE_TOOL_NAME,
  MAX_DISPATCH_TASKS,
  runClockBlock,
  SKILL_TOOL_NAME,
  TRANSFER_TOOL_NAME,
  withEngineBlocks,
  type AgentCapabilityDeps,
  type ImageHandle,
  type McpServerInfo,
  type SkillInfo,
  type SubagentInfo,
} from "./agentAssembly";
import { framedFetchedUrl } from "./documentParts";
import {
  createToolResultBudget,
  createToolResultEmitter,
  MAX_TOOL_RESULT_CHARS_PER_TURN,
  MIN_KEPT_RESULT_CHARS,
  turnTruncationMarker,
} from "./toolResultBudget";

// The façade: the split into `agentAssembly.ts` (what a run is told it can do)
// and `toolResultBudget.ts` (what a result may cost, and what it has to do) is
// internal — callers keep one import path.
export {
  assembleAgentRun,
  BUILTIN_TOOL_NAMES,
  buildAgentSystemPrompt,
  buildAgentTools,
  DISPATCH_TOOL_NAME,
  EDIT_IMAGE_TOOL_NAME,
  FETCH_URL_TOOL_NAME,
  IMAGE_TOOL_NAME,
  ImageRegistry,
  imagePromptUses,
  SKILL_TOOL_NAME,
  TRANSFER_TOOL_NAME,
} from "./agentAssembly";
export type {
  AgentCapabilityDeps,
  AgentRunAssembly,
  AgentSystemPromptInput,
  AgentToolsInput,
  AssembleAgentRunInput,
  ImageHandle,
  McpServerInfo,
  SkillInfo,
  SubagentInfo,
} from "./agentAssembly";
export {
  createToolResultBudget,
  createToolResultEmitter,
  MAX_TOOL_RESULT_CHARS_PER_TURN,
  MIN_KEPT_RESULT_CHARS,
  turnTruncationMarker,
} from "./toolResultBudget";
export type { ToolResultBudget } from "./toolResultBudget";

/**
 * What separates one dispatched agent's section from the next in the single
 * tool result they share. Named because the budget split has to price it: the
 * framing is charged to the group whether or not any answer fits.
 */
const SECTION_SEPARATOR = "\n\n";
const DEFAULT_MAX_TURN = 50;
/**
 * What separates one turn's words from the next turn's in the flattened answer.
 *
 * A blank line rather than a space: these are separate statements a step apart,
 * not a continued sentence, and every surface that renders the answer — Slack,
 * the chat bubble, an OpenAI client — reads a blank line as a paragraph break.
 */
const TURN_SEPARATOR = "\n\n";

export type RecordUsageFn = (record: {
  projectName: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}) => Promise<void>;

export interface EngineDeps {
  channel: LlmChannel;
  recordUsage?: RecordUsageFn;
}

/**
 * The four injected abilities live in {@link AgentCapabilityDeps}
 * (`agentAssembly.ts`), because their *presence* is what the assembly derives
 * the prompt and tool set from; the MCP dispatcher stays here — it serves
 * calls, but which MCP tools are offered arrives as run input, not off a dep.
 */
export interface AgentDeps extends EngineDeps, AgentCapabilityDeps {
  /** Dispatch an MCP tool by its (aliased) name. */
  callMcpTool?: (name: string, args: Record<string, unknown>) => Promise<McpToolResult>;
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
  const message = error instanceof Error ? error.message : String(error);
  // Never an empty string: an `{error: ""}` chunk is truthy-skipped by every
  // consumer's error gate yet classified "error" by `chunkTermination` — an
  // ending nobody handles, surfaced as a generic protocol failure instead of
  // the real one.
  return message || "unknown error";
}

/** MCP calls of one response that may be in flight at once. */
const MAX_PARALLEL_TOOL_CALLS = 5;

/**
 * Addresses one run may read.
 *
 * This platform's own policy, beside the loop that enforces it — the same
 * place `DEFAULT_MAX_TURN` sits. Generous for reading a handful of links, and
 * low enough that a run talked into sweeping a network runs out.
 */
const MAX_URL_FETCHES_PER_RUN = 20;

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
  let completed = false;
  try {
    while (true) {
      const step = await source.next();
      if (step.done) {
        completed = true;
        return step.value;
      }
      if (step.value.error && sink.error === undefined) {
        sink.error = step.value.error;
      }
      yield step.value;
    }
  } finally {
    // A consumer that walks away closes this generator, and a hand-written loop
    // — unlike the `yield*` this replaced — does not pass that on: the child
    // would stay suspended holding whatever its run opened, its MCP sessions
    // included. Same shape as `runSubagentWithPii` above, for the same reason.
    if (!completed) {
      await source.return("");
    }
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

  const result: RunResult = {
    content,
    model: modelUsed,
    usage,
    // The provider's own verdict: "length" is a response cut at the output
    // cap, not a finish — the difference `finish_reason: "stop"` used to erase.
    termination: choice?.finish_reason === "length" ? "output-limit" : "completed",
  };
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
  // What the provider said about its own ending: "length" means the response
  // was cut at the output cap, which `done: true` must not claim was a finish.
  let outputCut = false;
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
      if (chunk.choices[0]?.finish_reason === "length") {
        outputCut = true;
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
  if (outputCut) {
    // The provider cut the answer at its output cap. `done` would claim the
    // model finished on its own — the reason a truncated reply used to be
    // reported as a normal stop.
    yield { warning: "The answer was cut at the model's output limit before it finished." };
    yield { usage: usageInfo, finishReason: "output-limit" };
    return;
  }
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

/**
 * The call's arguments, or `null` when the text does not parse as a JSON
 * object. `null` is a distinct answer on purpose: a provider output cut leaves
 * the last call's arguments as half a JSON document, and mapping that to `{}`
 * ran the tool with empty arguments — a search with no query, reported as a
 * success. An empty string stays `{}`: a tool with no parameters legitimately
 * streams no argument text at all.
 */
function parseToolArguments(raw: string): Record<string, unknown> | null {
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
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

/**
 * One message as a single transcript line.
 *
 * Named apart from `messageText` in `domain/llm/types.ts` on purpose: that one
 * declares itself the single owner of "the words of a turn" and answers a
 * different question — it *drops* image parts and joins on newlines, because its
 * readers are a template, a prompt and a catalog search query.
 *
 * A transcript is neither. A turn that carried only a picture is not an empty
 * turn to the child reading it, so the image is named; and the result is one
 * line of a line-oriented budget, so it joins on spaces and trims. Sharing an
 * implementation here would make an image-only turn vanish from the transcript,
 * and sharing the *name* is what would make that look like a safe edit.
 */
function transcriptLine(content: ChatMessageInput["content"]): string {
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
    const text = transcriptLine(message.content);
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
 * Why a requested transfer target cannot be reached, or `undefined` when it can.
 *
 * Both transfer tools enumerate the offered names in their schema, but an enum
 * is a request, not a guarantee — OpenAI-compatible gateways vary in whether
 * they constrain against one, and a model that invents a name is a routine
 * outcome, not a platform fault. Before this, such a call was *attempted*: the
 * runner refused it one layer down as an authored `error` chunk, which the
 * engine then reported as a lost delegation — a warning in the user's face for
 * a model typo, a tool-result line promising an answer that was never coming,
 * and, for the model, "the agent returned no answer" with no hint of what it
 * could have asked for instead.
 *
 * Answered here the way an unloadable skill and an unknown image id already
 * are: a plain tool error naming the alternatives, which the model can act on
 * in its next turn.
 */
function unreachableAgent(agentName: string, subagents: SubagentInfo[]): string | undefined {
  if (subagents.some((agent) => agent.name === agentName)) {
    return undefined;
  }
  const names = subagents.map((agent) => agent.name);
  return `Error: Agent '${agentName}' is not connected to this agent. Available agents: ${
    names.length > 0 ? names.join(", ") : "none"
  }`;
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
  // Top-level chunks stay unauthored: "no author" is the contract every
  // consumer uses to pick out the visible answer. Subagent chunks are the only
  // authored ones — the runSubagent wrapper stamps the subagent's name.
  const author = undefined;

  // One assembly, shared with the Playground preview: what the model is told it
  // can do is decided here and nowhere else.
  const {
    systemPrompt,
    tools,
    builtinNames,
    // The offered list, not `input.subagents`: the assembly empties it when
    // nothing can carry a transfer, and everything downstream — the transcript
    // this run derives, the check that a requested target was offered — has to
    // agree with what the model was actually told.
    subagents,
    canEdit,
    canTransfer,
    images,
  } = assembleAgentRun(deps, {
    ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
    messages: input.messages,
    skills,
    ...(input.subagents ? { subagents: input.subagents } : {}),
    ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
    ...(input.mcpTools ? { mcpTools: input.mcpTools } : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(input.caller ? { caller: input.caller } : {}),
    ...(input.canDispatch ? { canDispatch: input.canDispatch } : {}),
  });
  /**
   * Which server served a tool, for the reader.
   *
   * An MCP tool's name is the server's own — `aws___search_documentation` — and
   * says nothing about which connection answered it once a version has several
   * attached. It rides on the result's display name the way a skill's and a
   * transfer's target already do; what the context receives is the content and a
   * call id, never this.
   */
  const serverByTool = new Map<string, string>();
  for (const server of input.mcpServers ?? []) {
    for (const toolName of server.toolNames) {
      serverByTool.set(toolName, server.name);
    }
  }
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
  // own context window (min with the fallback's — a mid-run switch must still
  // fit). The *effective* fallback, not the configured one: an image run drops
  // a fallback that cannot read images before the first call, and capping the
  // budget to a window that model will never serve starved runs at ~7% of
  // their real capacity. A fallback dropped later mid-run only leaves the min
  // over-conservative, which errs the safe way. The input and the declared
  // tools are charged up front; everything the loop adds is charged — or cut
  // to fit, with a report — as it enters. A run with headroom is
  // byte-identical to an unbudgeted one.
  const contextBudget = createRunContextBudget(
    input.model,
    fallbackModel,
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
  // Bounded per run, not per turn. Nothing else caps the *number* of outbound
  // requests — the turn budgets bound text — and "many requests, all failing"
  // is the shape an internal-network sweep takes.
  let urlFetches = 0;
  // Same rule for a turn the provider cut mid-tool-call: the run goes on, so
  // it is a warning rather than an ending, said once.
  let outputCutReported = false;

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
      //
      // The warning names its run: warnings surface without author labels on
      // every consumer, so a subagent's guard saying "the run stopped" reads
      // as the parent's ending next to the parent's finished answer. A child
      // is recognisable here by its continued turn counter — which cannot say
      // whether a transfer or a dispatch started it, so the wording claims
      // neither mechanism.
      const isSubagentRun = (input.startTurn ?? 0) > 0;
      yield {
        author,
        warning: isSubagentRun
          ? `Subagent '${input.projectName}' stopped at its turn limit (${maxTurn} turns) before finishing; the main run continues.`
          : `The run stopped at its turn limit (${maxTurn} turns) before the model finished answering.`,
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
    // The provider's own ending for this turn: "length" means the text was cut
    // at the output cap — an ending `done` must not report as a finish.
    let outputCut = false;
    const accumulator = new ToolCallAccumulator(usedCallIds);
    const contentRestorer = filter?.createStreamRestorer();
    const reasoningRestorer = filter?.createStreamRestorer();

    try {
      for await (const chunk of streamWithFallback(deps.channel, params, fallbackModel, state)) {
        if (chunk.usage) {
          usage = chunk.usage;
        }
        if (chunk.choices[0]?.finish_reason === "length") {
          outputCut = true;
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
      // Counted like any other visible word. The restorer holds back whatever
      // suffix could still turn out to be half a replacement token, so a turn
      // the provider cut just after `[[PII:` reaches the reader entirely
      // through this flush — and a `saidSomething` set only in the loop above
      // would leave the next turn's first word running straight into it.
      saidSomething = true;
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
      if (outputCut) {
        // The turn that would have been the answer was cut at the provider's
        // output cap — announced like the turn guard's ending, because a
        // truncated answer reported as a finish is the same silence.
        yield {
          author,
          warning: "The answer was cut at the model's output limit before it finished.",
        };
        yield { author, finishReason: "output-limit" };
        return;
      }
      yield { author, done: true };
      return;
    }

    if (outputCut && !outputCutReported) {
      // The provider cut this turn at its output cap while the model was
      // calling tools. The loop goes on — the model reads the error results
      // below and can retry — but the cut is announced: a truncated call plan
      // executed silently is the same defect as a truncated answer reported
      // as a finish.
      outputCutReported = true;
      yield {
        author,
        warning:
          "The model's turn was cut at its output limit while it was calling tools; the run continues.",
      };
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
      const parsedArgs = parseToolArguments(call.arguments);
      const args = parsedArgs ?? {};
      const displayArgs = filter
        ? (restoreValues(filter, args) as Record<string, unknown>)
        : args;
      // A call whose arguments did not parse — half a JSON document when the
      // provider cut the turn, or a model defect — is announced and answered
      // but never dispatched: running it with `{}` would report a call the
      // model never made as a success.
      return {
        call,
        args,
        displayArgs,
        malformed: parsedArgs === null,
        builtin: builtinNames.has(call.name),
      };
    });
    for (const { call, args, displayArgs, malformed } of prepared) {
      if (malformed) {
        // The model's own text is the only truthful record of arguments that
        // did not parse — re-encoding `{}` would claim it asked for nothing.
        const wireCall: ChannelToolCall = {
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        };
        wireToolCalls.push(wireCall);
        yield {
          author,
          delta: { toolCalls: [filter ? (restoreValues(filter, wireCall) as ChannelToolCall) : wireCall] },
        };
        continue;
      }
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
    const fetchDispatch = deps.fetchUrl;
    const mcpSettled = new Map<string, { ok: McpToolResult } | { err: unknown }>();
    const mcpCalls = mcpDispatch
      ? prepared.filter((entry) => !entry.builtin && !entry.malformed)
      : [];
    // `FetchUrl` joins the concurrent set rather than running in call order with
    // the other builtins. The order rule exists because a transfer moves the
    // turn budget and the image tools mutate the registry mid-loop; a fetch does
    // neither — its bytes are registered below, in order, like an MCP tool's.
    // Left sequential, three links in one answer would cost three round trips,
    // which is slower than the server this replaces.
    const fetchCalls: typeof prepared = [];
    if (fetchDispatch) {
      for (const entry of prepared) {
        if (entry.malformed || !entry.builtin || entry.call.name !== FETCH_URL_TOOL_NAME) {
          continue;
        }
        const url = typeof entry.args.url === "string" ? entry.args.url.trim() : "";
        if (!url) {
          // Answered rather than dispatched, and phrased as this engine's own
          // sentence — the call asked for nothing to read.
          mcpSettled.set(entry.call.id, {
            ok: { text: `Error: ${FETCH_URL_TOOL_NAME} requires a url.` },
          });
        } else if (urlFetches >= MAX_URL_FETCHES_PER_RUN) {
          mcpSettled.set(entry.call.id, {
            ok: {
              text: `Error: this run has already read ${MAX_URL_FETCHES_PER_RUN} addresses, which is its limit.`,
            },
          });
        } else {
          urlFetches += 1;
          fetchCalls.push(entry);
        }
      }
    }
    // One pool, so the concurrency cap means what it says: two pools would let a
    // turn run twice the limit.
    const concurrent = [
      ...mcpCalls.map((entry) => ({ entry, fetch: false })),
      ...fetchCalls.map((entry) => ({ entry, fetch: true })),
    ];
    if (concurrent.length > 0) {
      const settled = await mapWithLimit(concurrent, MAX_PARALLEL_TOOL_CALLS, async ({ entry, fetch }) => {
        try {
          if (!fetch) {
            return { ok: await mcpDispatch!(entry.call.name, entry.displayArgs) };
          }
          const url = String(entry.args.url);
          const read = await fetchDispatch!(url);
          // Normalised onto the MCP result shape on purpose: everything that
          // happens to a returned picture — the turn's image budget, the `img_N`
          // registration, the rejection notice for a model that cannot see one —
          // is already written once, below, and a second copy would drift.
          return {
            ok: {
              text: read.image ? `Image fetched from ${url}.` : framedFetchedUrl(url, read.text, read.note),
              ...(read.image ? { images: [read.image] } : {}),
            } satisfies McpToolResult,
          };
        } catch (err) {
          // A failed fetch is an ordinary answer, not a broken run: unlike an
          // MCP dispatcher throwing (a transport fault), this is the tool
          // reporting that the address did not work.
          if (fetch) {
            return { ok: { text: `Error: could not read that address — ${errorMessage(err)}` } };
          }
          return { err };
        }
      });
      concurrent.forEach(({ entry }, index) => {
        const result = settled[index];
        if (result) {
          mcpSettled.set(entry.call.id, result);
        }
      });
    }

    const resultBudget = createToolResultBudget(MAX_TOOL_RESULT_CHARS_PER_TURN, contextBudget);
    // Every result this turn leaves through here — see the emitter for why the
    // four steps are not a sequence any branch gets to spell out for itself.
    const toolResult = createToolResultEmitter(author, toolMessages, resultBudget, filter);

    for (const { call, args, displayArgs, builtin, malformed } of prepared) {
      if (malformed) {
        const errorText = outputCut
          ? `Error: the arguments of this call were cut at the model's output limit and did not parse; the call was not executed. Retry it with complete arguments.`
          : `Error: the arguments of this call did not parse as a JSON object; the call was not executed.`;
        yield toolResult(call, errorText, { bounded: true });
        continue;
      }
      if (builtin && call.name === TRANSFER_TOOL_NAME) {
        // Child runs at turn+1 and the parent resumes at turn+2, so two turns
        // must remain or the resume would trip the initial guard.
        if (turn + 2 >= maxTurn) {
          yield toolResult(call, "Error: Agent max_turn reached before transfer.", { bounded: true });
          continue;
        }
        const agentName = typeof args.agent_name === "string" ? args.agent_name : "";
        const message = typeof args.message === "string" ? args.message : "";
        if (!agentName || !message.trim() || !deps.runSubagent) {
          yield toolResult(call, "Error: transfer_to_agent requires agent_name and message.", {
            bounded: true,
          });
          continue;
        }
        // Checked before anything is spent on it, so a name the run never
        // offered is a tool error the model can correct — not a transfer that
        // is attempted, refused a layer down, and comes back to the reader as a
        // warning about a delegation that never existed.
        const unreachable = unreachableAgent(agentName, subagents);
        if (unreachable) {
          yield toolResult(call, unreachable, { bounded: true });
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
          yield toolResult(
            call,
            `Error: unknown image id in image_ids. Available images: ${known.length ? known.join(", ") : "none"}.`,
            { bounded: true },
          );
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
        //
        // Wrapped like a dispatched task's stream, and for the same reason: a
        // child never throws — the runner turns its failures into `error` chunks
        // and returns `""` — so this is the only way to say *why* it came back
        // with nothing. Only `dispatch_agents` did it, so a refused transfer
        // reached the parent as an empty answer carrying no reason, and the model
        // answered by guessing at one. The same provider refusal reported itself
        // through the `GenerateImage` builtin and vanished through a transfer to
        // an image project.
        const outcome: { error?: string } = {};
        const childText = yield* observeChildFailure(
          filter
            ? runSubagentWithPii(
                filter,
                deps.runSubagent,
                agentName,
                message,
                turn + 1,
                maxTurn,
                childImages,
                transcript,
              )
            : deps.runSubagent(agentName, message, turn + 1, maxTurn, childImages, transcript),
          outcome,
        );
        // A successful transfer used to leave no trace at all: only its failures
        // yielded a result, so a reader of the finished conversation could not
        // tell which agent had answered. Marked display-only — the child's
        // answer returns as its own message, and replaying this marker in its
        // place would say the delegation came back empty.
        yield toolResult(call, `Transferred to '${agentName}'; its answer follows.`, {
          name: `${TRANSFER_TOOL_NAME}: ${agentName}`,
          displayOnly: true,
          // No `fit`: an explicit `stored` is always charged whole, since the
          // engine wrote it and it is the same string every time.
          stored: JSON.stringify({ result: null }),
        });
        // A transfer's answer used to enter the context with no bound at all —
        // the one unbudgeted spot. The user already saw the child's full
        // answer stream by; only what re-enters the parent's context is cut.
        // Masked *before* it is charged and fitted: the budget must price the
        // exact string the messages array receives (mask tokens run longer
        // than what they replace), and a fit that cut through a raw address
        // would leave a fragment the mask no longer recognises. The wrapper
        // is charged first and the marker is reserved inside the fit, so the
        // whole message this pushes — wrapper, answer, marker — is inside the
        // budget, not riding on its headroom.
        //
        // The answer decides whether the transfer failed, never the `error`
        // chunks that went past — a child answers from a nested transfer's
        // failure (it arrives as a tool error), and a deeper descendant's error
        // travels out on this same stream. Only an empty answer is explained by
        // what `observeChildFailure` caught, which is the rule a dispatched task
        // already follows.
        const answer = childText.trim();
        const childReply =
          answer ||
          (outcome.error ? `Error: ${outcome.error}` : "Error: the agent returned no answer.");
        if (!answer) {
          // The reason reaches the reader, not only the model. Every consumer
          // drops an authored `error` chunk on the grounds that the parent
          // answers past it — true, but the parent could not say what happened
          // either, so the failure was legible in the trace and nowhere else.
          // A warning because the run goes on; named in the text because
          // warnings surface without author labels.
          yield {
            author,
            warning: outcome.error
              ? `Agent '${agentName}' returned no answer: ${outcome.error}`
              : `Agent '${agentName}' returned no answer.`,
          };
        }
        const maskedChildText = filter?.mask(childReply) ?? childReply;
        contextBudget?.chargeText(subagentContextMessage(agentName, ""));
        const fittedChild = contextBudget?.fitText(maskedChildText, {
          suffix: "\n…[truncated: the run's context budget is exhausted]",
          // Same floor as a tool result: a few dozen characters of a child's
          // introduction read as its whole answer, which is worse than saying
          // the answer could not be included.
          minKeepChars: MIN_KEPT_RESULT_CHARS,
        }) ?? { text: maskedChildText, truncated: false, kept: true };
        let childAnswer = fittedChild.text;
        if (!fittedChild.kept) {
          childAnswer =
            "…[the agent's answer could not be included: the run's context budget is exhausted]";
          contextBudget?.chargeText(childAnswer);
        }
        postContextMessages.push({
          role: "user",
          content: subagentContextMessage(agentName, childAnswer),
        });
        nextTurn = Math.max(nextTurn, turn + 2);
        continue;
      }

      if (builtin && call.name === DISPATCH_TOOL_NAME && deps.runSubagent) {
        const dispatchSubagent = deps.runSubagent;
        // A group costs the parent exactly what one transfer costs: the children
        // run at turn+1 and the parent resumes at turn+2 however many there were.
        if (turn + 2 >= maxTurn) {
          yield toolResult(call, `Error: Agent max_turn reached before ${DISPATCH_TOOL_NAME}.`, {
            bounded: true,
          });
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
          yield toolResult(
            call,
            `Error: ${DISPATCH_TOOL_NAME} requires a non-empty tasks array; each task needs agent_name and message.`,
            { bounded: true },
          );
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
          // Same refusal a transfer makes, in the slot this shape already has
          // for a task that cannot run: its section says why, and the tasks
          // beside it still run.
          const unreachable = unreachableAgent(agentName, subagents);
          if (unreachable) {
            return { agentName, failure: unreachable };
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
        //
        // Divided over what this turn has **left**, not over the per-turn cap.
        // The cap is what the turn started with, and a dispatch is one call
        // among however many the model made in the same response — so sizing
        // the shares against it produced a group larger than the budget
        // remaining, which the single `fit` below then cut from the tail. The
        // even split survived right up to the point where it mattered, and the
        // tasks it exists to protect were the ones erased.
        //
        // What is not a task's answer comes off the top first: the group's
        // `Error:` prefix when nothing succeeded, each section's heading, the
        // blank line between sections, the reason a task the plan refused
        // carries, and room for the marker `fit` appends after cutting a
        // section to its share. Those are this engine's own short strings and
        // are never the thing to cut. The reason a task that *ran* and failed
        // carries is different: it is child- or provider-written text whose
        // length nothing on this side decides, so it is fitted to the task's
        // share like an answer — uncounted, one long provider error pushed the
        // group past the budget and the final fit cut the tail: the good
        // answers. The run's context budget can still bind tighter — it is
        // measured in tokens, not characters — and when it does the same
        // `fit` cuts and says so.
        const sectionHeading = (agentName: string) => `### ${agentName}\n`;
        // A failed group is prefixed before the shares are sized, so the
        // prefix is known — and priced — here. The answer decides failure, not
        // the error chunks that went past: a child whose nested transfer
        // failed still answers from that tool error, and a descendant's
        // failure surfaces on this same stream — treating either as the
        // task's outcome would throw away the answer it actually produced,
        // and one recovered failure per task would report the whole call
        // failed.
        const allFailed = runnable.every((_, position) => !(answers[position] ?? "").trim());
        const groupPrefix = allFailed
          ? `Error: no agent in this ${DISPATCH_TOOL_NAME} call produced an answer.\n\n`
          : "";
        // The widest marker a share's fit can append: kept never prints more
        // digits than the turn cap, and no answer outgrows a safe integer.
        const markerAllowance = turnTruncationMarker(
          MAX_TOOL_RESULT_CHARS_PER_TURN,
          Number.MAX_SAFE_INTEGER,
        ).length;
        const framingChars =
          groupPrefix.length +
          plans.reduce(
            (total, plan) =>
              total +
              sectionHeading(plan.agentName).length +
              ("failure" in plan ? plan.failure.length : 0),
            0,
          ) + Math.max(0, plans.length - 1) * SECTION_SEPARATOR.length;
        const perTask = Math.max(
          1,
          Math.floor(
            Math.max(0, resultBudget.remaining() - framingChars) / Math.max(1, runnable.length),
          ) - markerAllowance,
        );
        const answerByIndex = new Map<number, string>();
        runnable.forEach(({ index, outcome }, position) => {
          const answer = (answers[position] ?? "").trim();
          answerByIndex.set(
            index,
            createToolResultBudget(perTask).fit(
              answer ||
                (outcome.error ? `Error: ${outcome.error}` : "Error: the agent returned no answer."),
            ),
          );
        });
        const sections = plans.map((plan, index) => ({
          agentName: plan.agentName,
          text:
            "failure" in plan
              ? plan.failure
              : (answerByIndex.get(index) ?? "Error: the agent did not run."),
        }));
        // Prefixed `Error:` only when nothing succeeded. A partial failure is not
        // a failed call — the sections that answered are usable, and the trace
        // reads this prefix to decide whether the span failed.
        const body = sections
          .map((section) => `${sectionHeading(section.agentName)}${section.text}`)
          .join(SECTION_SEPARATOR);
        const dispatchText = `${groupPrefix}${body}`;
        // Through the turn budget like any other tool result, which is the reason
        // the answers come back here instead of as an unbudgeted context message.
        yield toolResult(call, dispatchText);
        nextTurn = Math.max(nextTurn, turn + 2);
        continue;
      }

      if (builtin && call.name === IMAGE_TOOL_NAME && deps.generateImage) {
        const maskedPrompt = typeof args.prompt === "string" ? args.prompt : "";
        const displayPrompt = typeof displayArgs.prompt === "string" ? displayArgs.prompt : "";
        const size = typeof displayArgs.size === "string" ? displayArgs.size : undefined;
        const quality = typeof displayArgs.quality === "string" ? displayArgs.quality : undefined;
        let resultText: string;
        // Every outcome here is a string this engine wrote — only the provider's
        // error body has a length nothing on this side decides.
        let fromProvider = false;
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
            fromProvider = true;
            resultText = `Error: image generation failed. ${errorMessage(error)}`;
          }
        }
        // Only the provider's body is fitted. A refusal this engine wrote is
        // charged whole, or a turn whose budget an earlier tool result spent
        // would answer "request less data" to a call that forgot its prompt.
        yield toolResult(call, resultText, { bounded: !fromProvider });
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
        /** See GenerateImage above. */
        let fromProvider = false;
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
            fromProvider = true;
            resultText = `Error: image edit failed. ${errorMessage(error)}`;
          }
        }
        // Same split as GenerateImage above.
        yield toolResult(call, resultText, { bounded: !fromProvider });
        continue;
      }

      let content: string;
      let resultName = call.name;
      // A call nothing can serve is refused in one sentence this engine wrote;
      // everything else here is a skill body or a tool's payload, whose length
      // is not ours. Same split as the image builtins above.
      let bounded = false;
      if (builtin && call.name === SKILL_TOOL_NAME && deps.loadSkillContent) {
        const skillName = typeof displayArgs.skill_name === "string" ? displayArgs.skill_name : "";
        const filePath =
          typeof displayArgs.file_path === "string" ? displayArgs.file_path : undefined;
        content = await loadSkillSafe(deps.loadSkillContent, skills, skillName, filePath);
        if (skillName) {
          resultName = `${SKILL_TOOL_NAME}: ${skillName}`;
        }
      } else {
        const server = serverByTool.get(call.name);
        if (server) {
          resultName = `${server}: ${call.name}`;
        }
        const settled = mcpSettled.get(call.id);
        if (!settled) {
          content = `Error: Tool '${call.name}' cannot be executed in this context.`;
          bounded = true;
        } else if ("err" in settled) {
          // Dispatched above; a thrown dispatcher still tears the run down here,
          // in call order, exactly as a sequential dispatch did.
          input.signal?.throwIfAborted();
          throw settled.err;
        } else {
          input.signal?.throwIfAborted();
          content = settled.ok.text;
          // Files ride straight out to the surface. Unlike images they never
          // enter the context — a model cannot read a DOCX, and `content`
          // already names it — so no budget, fallback rule or follow-up message
          // is involved, and a consumer that does not know the field is
          // unaffected.
          for (const file of settled.ok.files ?? []) {
            yield { author, file: { ...file, source: `mcp: ${call.name}` } };
          }
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
      yield toolResult(call, content, { name: resultName, bounded });
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
