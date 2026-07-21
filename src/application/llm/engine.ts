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
import { renderTemplate } from "./template";

export const SKILL_TOOL_NAME = "Skill";
export const TRANSFER_TOOL_NAME = "transfer_to_agent";
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

function buildPromptMessages(input: RunPromptInput): ChannelMessage[] {
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
  return messages;
}

export async function runPrompt(deps: EngineDeps, input: RunPromptInput): Promise<RunResult> {
  const messages = buildPromptMessages(input);
  const params = buildChannelParams(input.model, messages, input.parameters);
  const { completion, modelUsed } = await completionWithFallback(
    deps.channel,
    params,
    input.fallbackModel,
  );
  const choice = completion.choices[0];
  const content = choice?.message.content ?? "";
  const usage = toUsageInfo(modelUsed, completion.usage);
  await recordUsageIfPossible(deps, input.projectName, modelUsed, usage);

  const result: RunResult = { content, model: modelUsed, usage };
  if (choice?.message.tool_calls && choice.message.tool_calls.length > 0) {
    result.toolCalls = choice.message.tool_calls;
  }
  return result;
}

export async function* runPromptStream(
  deps: EngineDeps,
  input: RunPromptInput,
): AsyncGenerator<EngineChunk> {
  const messages = buildPromptMessages(input);
  const params = buildChannelParams(input.model, messages, input.parameters);
  const state = { model: input.model };
  let usage: ChannelUsage | null = null;

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
        yield { delta: { content: delta.content } };
      } else if (delta.reasoning_content) {
        yield { delta: { reasoningContent: delta.reasoning_content } };
      }
    }
  } catch (error) {
    yield { error: errorMessage(error) };
    return;
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
): string {
  const parts: string[] = [];
  if (base) {
    parts.push(base);
  }
  if (skills.length > 0) {
    parts.push(skillSystemPromptAddition(skills));
  }
  if (subagents.length > 0) {
    parts.push(subagentSystemPromptAddition(subagents));
  }
  return parts.join("\n\n");
}

function buildAgentTools(
  mcpTools: ChannelToolDef[] | undefined,
  skills: SkillInfo[],
  subagents: SubagentInfo[],
): ChannelToolDef[] {
  const tools: ChannelToolDef[] = [...(mcpTools ?? [])];
  if (skills.length > 0) {
    tools.push(skillToolDef(skills));
  }
  if (subagents.length > 0) {
    tools.push(transferToolDef(subagents));
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
  // Only tag chunks with an author when subagents are wired, so the plain
  // OpenAI chunk shape is preserved otherwise.
  const author = hasSubagents ? input.projectName : undefined;

  const systemPrompt = buildAgentSystemPrompt(input.systemPrompt, skills, subagents);
  const tools = buildAgentTools(input.mcpTools, skills, subagents);

  const messages: ChannelMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push(...(input.messages as ChannelMessage[]));

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
          yield { author, delta: { content: delta.content } };
        } else if (delta.reasoning_content) {
          reasoningText += delta.reasoning_content;
          yield { author, delta: { reasoningContent: delta.reasoning_content } };
        } else if (delta.tool_calls) {
          for (const toolCall of delta.tool_calls) {
            accumulator.add(toolCall);
          }
        }
      }
    } catch (error) {
      yield { author, error: errorMessage(error) };
      return;
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
      yield { author, delta: { toolCalls: [wireItem] } };

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
        const childText = yield* deps.runSubagent(agentName, message, turn + 1, maxTurn);
        toolMessages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ result: null }),
        });
        postContextMessages.push({
          role: "user",
          content: subagentContextMessage(agentName, childText),
        });
        nextTurn = Math.max(nextTurn, turn + 2);
        continue;
      }

      let content: string;
      if (call.name === SKILL_TOOL_NAME && deps.loadSkillContent) {
        const skillName = typeof args.skill_name === "string" ? args.skill_name : "";
        const filePath = typeof args.file_path === "string" ? args.file_path : undefined;
        content = await loadSkillSafe(deps.loadSkillContent, skills, skillName, filePath);
      } else if (deps.callMcpTool) {
        content = await deps.callMcpTool(call.name, args);
      } else {
        content = `Error: Tool '${call.name}' cannot be executed in this context.`;
      }
      yield { author, toolResult: { toolCallId: call.id, name: call.name, content } };
      toolMessages.push({ role: "tool", tool_call_id: call.id, content });
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
