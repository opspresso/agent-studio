/**
 * LLM engine. Runs prompt and agent executions over a single
 * OpenAI-compatible channel:
 *   - runPrompt / runPromptStream: single-shot generation with fallback retry.
 *   - runAgent: recursive multi-turn tool loop (Skill + transfer_to_agent
 *     builtins intercepted before MCP dispatch).
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
import { calculateCost } from "@/domain/llm/models";
import type {
  ChatMessageInput,
  EngineChunk,
  EngineParameters,
  RunResult,
  UsageInfo,
} from "@/domain/llm/types";
import { PiiFilter } from "./pii";
import { renderTemplate } from "./template";

export const SKILL_TOOL_NAME = "Skill";
export const TRANSFER_TOOL_NAME = "transfer_to_agent";
export const IMAGE_TOOL_NAME = "GenerateImage";
const DEFAULT_MAX_TURN = 50;

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
  callMcpTool?: (name: string, args: Record<string, unknown>) => Promise<string>;
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
  ) => AsyncGenerator<EngineChunk, string>;
  /** Generate an image for the builtin GenerateImage tool. */
  generateImage?: (
    prompt: string,
    size?: string,
    quality?: string,
  ) => Promise<{ b64: string; mimeType: string }>;
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
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
): ChannelParams {
  const params: ChannelParams = { model, messages };
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
  return params;
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
      const completion = await channel.chatCompletion({ ...params, model: fallbackModel });
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
  for await (const chunk of channel.chatCompletionStream({ ...params, model: fallbackModel })) {
    yield chunk;
  }
}

async function recordUsageIfPossible(
  deps: EngineDeps,
  projectName: string | undefined,
  model: string,
  usage: UsageInfo,
): Promise<void> {
  if (deps.recordUsage && projectName) {
    await deps.recordUsage({
      projectName,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
    });
  }
}

// ---------------------------------------------------------------------------
// Single-shot generation
// ---------------------------------------------------------------------------

function maskValues(filter: PiiFilter, value: unknown): unknown {
  if (typeof value === "string") {
    return filter.mask(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskValues(filter, item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, maskValues(filter, item)]),
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
      Object.entries(value).map(([key, item]) => [key, restoreValues(filter, item)]),
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
): AsyncGenerator<EngineChunk, string> {
  const source = runSubagent(agentName, message, turn, maxTurn);
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
  const filter = input.parameters?.piiFiltering ? new PiiFilter() : undefined;
  const messages = buildPromptMessages(input, filter);
  const params = buildChannelParams(input.model, messages, input.parameters);
  const { completion, modelUsed } = await completionWithFallback(
    deps.channel,
    params,
    input.fallbackModel,
  );
  const choice = completion.choices[0];
  const content = filter?.restore(choice?.message.content ?? "") ?? choice?.message.content ?? "";
  const usage = toUsageInfo(modelUsed, completion.usage);
  await recordUsageIfPossible(deps, input.projectName, modelUsed, usage);

  const result: RunResult = { content, model: modelUsed, usage };
  if (choice?.message.tool_calls && choice.message.tool_calls.length > 0) {
    result.toolCalls = filter
      ? (restoreValues(filter, choice.message.tool_calls) as unknown[])
      : choice.message.tool_calls;
  }
  return result;
}

export async function* runPromptStream(
  deps: EngineDeps,
  input: RunPromptInput,
): AsyncGenerator<EngineChunk> {
  const filter = input.parameters?.piiFiltering ? new PiiFilter() : undefined;
  const messages = buildPromptMessages(input, filter);
  const params = buildChannelParams(input.model, messages, input.parameters);
  const state = { model: input.model };
  let usage: ChannelUsage | null = null;
  const contentRestorer = filter?.createStreamRestorer();
  const reasoningRestorer = filter?.createStreamRestorer();

  try {
    for await (const chunk of streamWithFallback(deps.channel, params, input.fallbackModel, state)) {
      if (chunk.usage) {
        usage = chunk.usage;
      }
      const delta = chunk.choices[0]?.delta;
      if (!delta) {
        continue;
      }
      if (delta.content) {
        const content = contentRestorer?.push(delta.content) ?? delta.content;
        if (content) {
          yield { delta: { content } };
        }
      } else if (delta.reasoning_content) {
        const reasoningContent =
          reasoningRestorer?.push(delta.reasoning_content) ?? delta.reasoning_content;
        if (reasoningContent) {
          yield { delta: { reasoningContent } };
        }
      }
    }
  } catch (error) {
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

  finalize(): AccumulatedCall[] {
    const calls: AccumulatedCall[] = [];
    for (const index of this.order) {
      const entry = this.byIndex.get(index);
      if (entry && entry.name) {
        calls.push(entry);
      }
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
    .map((s) => `| ${s.name} | ${s.description || "No description"} |`)
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

function mcpSystemPromptAddition(servers: McpServerInfo[]): string {
  const rows = servers
    .map((s) => `| ${s.name} | ${s.description} | ${s.toolNames.join(", ")} |`)
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

function transferToolDef(subagents: SubagentInfo[]): ChannelToolDef {
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
        },
        required: ["agent_name", "message"],
      },
    },
  };
}

function buildAgentSystemPrompt(
  base: string | undefined,
  skills: SkillInfo[],
  subagents: SubagentInfo[],
  mcpServers: McpServerInfo[],
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

function buildAgentTools(
  mcpTools: ChannelToolDef[] | undefined,
  skills: SkillInfo[],
  subagents: SubagentInfo[],
  withImageTool: boolean,
): ChannelToolDef[] {
  const tools: ChannelToolDef[] = [...(mcpTools ?? [])];
  if (skills.length > 0) {
    tools.push(skillToolDef(skills));
  }
  if (subagents.length > 0) {
    tools.push(transferToolDef(subagents));
  }
  if (withImageTool) {
    tools.push(IMAGE_TOOL_DEF);
  }
  return tools;
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
  const maxTurn = input.maxTurn ?? DEFAULT_MAX_TURN;
  const skills = input.skills ?? [];
  const subagents = input.subagents ?? [];
  const hasSubagents = subagents.length > 0;
  // Top-level chunks stay unauthored: "no author" is the contract every
  // consumer uses to pick out the visible answer. Subagent chunks are the only
  // authored ones — the runSubagent wrapper stamps the subagent's name.
  const author = undefined;

  const systemPrompt = buildAgentSystemPrompt(
    input.systemPrompt,
    skills,
    subagents,
    input.mcpServers ?? [],
  );
  const tools = buildAgentTools(input.mcpTools, skills, subagents, Boolean(deps.generateImage));
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
  while (true) {
    if (turn >= maxTurn) {
      return; // turn guard
    }

    const params = buildChannelParams(input.model, messages, input.parameters, tools);
    const state = { model: input.model };
    let assistantText = "";
    let reasoningText = "";
    let usage: ChannelUsage | null = null;
    const accumulator = new ToolCallAccumulator();
    const contentRestorer = filter?.createStreamRestorer();
    const reasoningRestorer = filter?.createStreamRestorer();

    try {
      for await (const chunk of streamWithFallback(
        deps.channel,
        params,
        input.fallbackModel,
        state,
      )) {
        if (chunk.usage) {
          usage = chunk.usage;
        }
        const delta = chunk.choices[0]?.delta;
        if (!delta) {
          continue;
        }
        if (delta.content) {
          assistantText += delta.content;
          const content = contentRestorer?.push(delta.content) ?? delta.content;
          if (content) {
            yield { author, delta: { content } };
          }
        } else if (delta.reasoning_content) {
          reasoningText += delta.reasoning_content;
          const reasoningContent =
            reasoningRestorer?.push(delta.reasoning_content) ?? delta.reasoning_content;
          if (reasoningContent) {
            yield { author, delta: { reasoningContent } };
          }
        } else if (delta.tool_calls) {
          for (const toolCall of delta.tool_calls) {
            accumulator.add(toolCall);
          }
        }
      }
    } catch (error) {
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
    let nextTurn = turn + 1;

    for (const call of calls) {
      const args = parseToolArguments(call.arguments);
      const wireItem = toWireToolCall(call.id, call.name, args);
      wireToolCalls.push(wireItem);
      const displayArgs = filter
        ? (restoreValues(filter, args) as Record<string, unknown>)
        : args;
      yield { author, delta: { toolCalls: [toWireToolCall(call.id, call.name, displayArgs)] } };

      if (hasSubagents && call.name === TRANSFER_TOOL_NAME) {
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
            )
          : yield* deps.runSubagent(agentName, message, turn + 1, maxTurn);
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

      if (call.name === IMAGE_TOOL_NAME && deps.generateImage) {
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
            resultText =
              "Image generated and delivered to the user. Briefly describe what was drawn; do not claim you cannot show images.";
          } catch (error) {
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

      let content: string;
      let resultName = call.name;
      if (call.name === SKILL_TOOL_NAME && deps.loadSkillContent) {
        const skillName = typeof displayArgs.skill_name === "string" ? displayArgs.skill_name : "";
        const filePath =
          typeof displayArgs.file_path === "string" ? displayArgs.file_path : undefined;
        content = await loadSkillSafe(deps.loadSkillContent, skills, skillName, filePath);
        if (skillName) {
          resultName = `${SKILL_TOOL_NAME}: ${skillName}`;
        }
      } else if (deps.callMcpTool) {
        content = await deps.callMcpTool(call.name, displayArgs);
      } else {
        content = `Error: Tool '${call.name}' cannot be executed in this context.`;
      }
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
