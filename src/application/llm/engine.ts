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
import { PiiFilter } from "./pii";
import { renderTemplate } from "./template";

export const SKILL_TOOL_NAME = "Skill";
export const TRANSFER_TOOL_NAME = "transfer_to_agent";
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
  IMAGE_TOOL_NAME,
  EDIT_IMAGE_TOOL_NAME,
];
const DEFAULT_MAX_TURN = 50;

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
  signal?: AbortSignal;
}

export interface RunAgentInput {
  projectName: string;
  model: string;
  fallbackModel?: string;
  systemPrompt?: string;
  messages: ChatMessageInput[];
  parameters?: EngineParameters;
  maxTurn?: number;
  /** Starting turn, used when a subagent continues the parent's turn budget. */
  startTurn?: number;
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
 * Spend one turn's tool-result budget in call order. Truncation is explicit so
 * the model can narrow its next call instead of silently working from a cut-off
 * payload; an entirely omitted result is reported as an error, which also makes
 * budget exhaustion visible as a failed span in the trace.
 */
function createToolResultBudget(total: number): (content: string) => string {
  let remaining = total;
  return (content) => {
    if (content.length <= remaining) {
      remaining -= content.length;
      return content;
    }
    const room = remaining;
    remaining = 0;
    if (room <= 0) {
      return "Error: tool result omitted — this turn's tool output budget is exhausted. Request less data, or call one tool at a time.";
    }
    return `${content.slice(0, room)}\n…(truncated: kept ${room} of ${content.length} chars, this turn's tool output budget is exhausted)`;
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
  console.warn(`[engine] fallback skipped for an image request: ${reject}`);
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
    console.error("[engine] usage recording failed", errorMessage(error));
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

async function* runSubagentWithPii(
  filter: PiiFilter,
  runSubagent: NonNullable<AgentDeps["runSubagent"]>,
  agentName: string,
  message: string,
  turn: number,
  maxTurn: number,
  images?: Array<{ b64: string; mimeType: string }>,
): AsyncGenerator<EngineChunk, string> {
  const source = runSubagent(agentName, message, turn, maxTurn, images);
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

function buildPromptMessages(input: RunPromptInput, filter?: PiiFilter): ChannelMessage[] {
  const messages: ChannelMessage[] = [];
  if (input.systemPrompt) {
    messages.push({ role: "system", content: input.systemPrompt });
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

function skillSystemPromptAddition(skills: SkillInfo[]): string {
  const rows = skills
    .map((s) => `| ${s.name} | ${tableCell(s.description) || "No description"} |`)
    .join("\n");
  return [
    "## Available Skills",
    "",
    "You have access to the following skills. Use the `Skill` tool to load a skill's content when needed.",
    "",
    "| Skill | Description |",
    "|-------|-------------|",
    rows,
    "",
    "To use a skill, call the Skill tool with the skill name. You can also request specific files within a skill by providing the file_path parameter.",
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
  return [
    "## Connected MCP Servers",
    "",
    "The tools listed below come from external MCP servers. Use a server's description to decide when its tools are relevant.",
    "",
    "| Server | Description | Tools |",
    "|--------|-------------|-------|",
    rows,
  ].join("\n");
}

function subagentSystemPromptAddition(subagents: SubagentInfo[]): string {
  const blocks = subagents
    .map((a) => `Agent name: ${a.name}\nAgent description: ${a.description || "No description"}`)
    .join("\n\n");
  const quoted = subagents.map((a) => `\`${a.name}\``).join(", ");
  return [
    "You have a list of other agents to transfer to:",
    "",
    blocks,
    "",
    "If you are the best to answer the question according to your description,",
    "you can answer it.",
    "",
    "If another agent is better for answering the question according to its",
    "description, call `transfer_to_agent` function to transfer the question to that agent.",
    "When you transfer, write a self-contained `message` for that agent.",
    "Once you have obtained the desired answer by calling `transfer_to_agent`, you do not need to call the same agent again to respond.",
    "",
    "NOTE: the only available agents for `transfer_to_agent` function are",
    `${quoted}.`,
  ].join("\n");
}

function skillToolDef(skills: SkillInfo[]): ChannelToolDef {
  const names = skills.map((s) => s.name).join(", ");
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
            description: `The name of the skill to load. Available skills: ${names}`,
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
                    "Ids of images to hand over (see Available Images). Pass these when the other agent must edit or look at an existing image instead of making one up.",
                },
              }
            : {}),
        },
        required: ["agent_name", "message"],
      },
    },
  };
}

function imageSystemPromptAddition(
  handles: readonly ImageHandle[],
  uses: { canEdit: boolean; canTransfer: boolean },
): string {
  // Listed even when empty: the image tools' only documentation is a pointer to
  // this section, so it has to exist before the first picture does.
  const table =
    handles.length > 0
      ? [
          "| Image | Source |",
          "|-------|--------|",
          ...handles.map((h) => `| ${h.id} | ${tableCell(h.origin)} |`),
        ]
      : ["No images yet — an image you generate gets an id you can use here."];
  const howTo: string[] = [];
  if (uses.canEdit) {
    howTo.push(
      `Pass an id to the \`${EDIT_IMAGE_TOOL_NAME}\` tool to change that image. An image you generate later also gets an id, reported in the ${IMAGE_TOOL_NAME} result.`,
    );
  }
  if (uses.canTransfer) {
    howTo.push(
      `Pass ids as \`image_ids\` on \`${TRANSFER_TOOL_NAME}\` so the other agent receives the actual picture instead of a description of it.`,
    );
  }
  return ["## Available Images", "", ...howTo.flatMap((line) => [line, ""]), ...table].join("\n");
}

function buildAgentSystemPrompt(
  base: string | undefined,
  skills: SkillInfo[],
  subagents: SubagentInfo[],
  mcpServers: McpServerInfo[],
  images: { handles: readonly ImageHandle[]; canEdit: boolean; canTransfer: boolean },
): string {
  const parts: string[] = [];
  if (base) {
    parts.push(base);
  }
  if (skills.length > 0) {
    parts.push(skillSystemPromptAddition(skills));
  }
  if (mcpServers.length > 0) {
    parts.push(mcpSystemPromptAddition(mcpServers));
  }
  if (subagents.length > 0) {
    parts.push(subagentSystemPromptAddition(subagents));
  }
  if (images.canEdit || images.canTransfer) {
    parts.push(imageSystemPromptAddition(images.handles, images));
  }
  return parts.join("\n\n");
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

function buildAgentTools(
  mcpTools: ChannelToolDef[] | undefined,
  skills: SkillInfo[],
  subagents: SubagentInfo[],
  withImageTool: boolean,
  withEditTool: boolean,
  withImageTransfer: boolean,
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
  const hasSubagents = subagents.length > 0;
  // Top-level chunks stay unauthored: "no author" is the contract every
  // consumer uses to pick out the visible answer. Subagent chunks are the only
  // authored ones — the runSubagent wrapper stamps the subagent's name.
  const author = undefined;

  // Handles are worth keeping when something can act on them: this run can edit
  // an image, or it can hand one to another agent that will.
  const canEdit = Boolean(deps.editImage);
  const canTransfer = hasSubagents && Boolean(deps.runSubagent);
  const images = new ImageRegistry();
  if (canEdit || canTransfer) {
    registerInputImages(images, input.messages);
  }
  const systemPrompt = buildAgentSystemPrompt(
    input.systemPrompt,
    skills,
    subagents,
    input.mcpServers ?? [],
    { handles: images.list(), canEdit, canTransfer },
  );
  const { tools, builtinNames } = buildAgentTools(
    input.mcpTools,
    skills,
    subagents,
    Boolean(deps.generateImage),
    canEdit,
    canTransfer,
  );
  const filter = input.parameters?.piiFiltering ? new PiiFilter() : undefined;

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

  let turn = input.startTurn ?? 0;
  // Ids already spoken for, across every turn: what the assistant message a
  // chat persists must not repeat.
  const usedCallIds = new Set<string>();
  // One turn's worth of pictures an MCP tool may add to the context, sharing the
  // cap a user turn gets — they cost the same and arrive the same way.
  let imageBudget = MAX_ATTACHMENTS;
  while (true) {
    if (turn >= maxTurn) {
      return; // turn guard
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
          assistantText += delta.content;
          const content = contentRestorer?.push(delta.content) ?? delta.content;
          if (content) {
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

    const spendResultBudget = createToolResultBudget(MAX_TOOL_RESULT_CHARS_PER_TURN);

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
        // Pass ONLY the model-written message (no parent history). The child's
        // final text returns as a "For context" user message.
        const childText = filter
          ? yield* runSubagentWithPii(
              filter,
              deps.runSubagent,
              agentName,
              message,
              turn + 1,
              maxTurn,
              childImages,
            )
          : yield* deps.runSubagent(agentName, message, turn + 1, maxTurn, childImages);
        toolMessages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ result: null }),
        });
        postContextMessages.push({
          role: "user",
          content:
            filter?.mask(subagentContextMessage(agentName, childText)) ??
            subagentContextMessage(agentName, childText),
        });
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
            // A tool message carries text only, so the bytes ride on the
            // follow-up user message appended after this turn's tool results.
            content += `\n\n${accepted.length} image(s) returned by this tool are attached to the next message${
              ids.length > 0 ? ` (image id${ids.length > 1 ? "s" : ""}: ${ids.join(", ")})` : ""
            }.`;
            const dropped = produced.length - accepted.length;
            if (dropped > 0) {
              content += ` ${dropped} more were dropped: at most ${MAX_ATTACHMENTS} images per turn.`;
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

    if (attachedImages.length > 0) {
      // A tool message is text-only, so the bytes enter as a user turn — the
      // same route a transfer's "For context" answer takes.
      postContextMessages.push({
        role: "user",
        content: [
          { type: "text", text: "Images returned by the tool calls above:" },
          ...attachedImages.map((image) => ({
            type: "image_url" as const,
            image_url: { url: imageDataUrl(image) },
          })),
        ],
      });
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
    messages.push(assistantMessage, ...toolMessages, ...postContextMessages);
    turn = nextTurn;
  }
}
