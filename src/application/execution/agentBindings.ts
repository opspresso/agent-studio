import { buildFileTool } from "@/application/document/fileTool";
import type { AgentConfiguration } from "@/domain/agent/types";
import { descend, type RunOrigin } from "@/domain/execution/actor";
import { imageDataUrl } from "@/domain/llm/types";
import { DEFAULT_CALL_ROUTING_POLICY, MODEL_ROUTING_POLICY_BINDING } from "@/domain/llm/callRouting";
import type { AgentDeps, AgentTask, PreparedAgent, RecordUsageFn } from "@/application/runtime/types";
import { assertModelsPriceable } from "@/application/run/modelPolicy";
import { assertWithinCostLimit } from "@/application/usage/costGuard";
import { ValidationError } from "@/application/errors";
import { runtimeFingerprint, type RuntimeTurnPersistence } from "@/application/runtime/session";
import { buildSkillLoader, createSkillReader, discoveryQueries, resolveRunTools } from "./bindings";
import { prepareMemoryForRun } from "./memoryRecall";
import { buildImageEditor, buildImageGenerator, resolveImageModel } from "./imageTool";
import { buildUrlFetcher } from "./urlTool";
import { buildFileSaver } from "./saveFileTool";
import { buildSlackReader } from "./slackTool";
import { closeMcp } from "./mcpTools";
import { callerFor, runClock, toEngineParameters, type ExecutionDeps } from "./deps";

export const MAX_SUBAGENT_DEPTH = 5;

/** Bind Studio capabilities and credentials. SDK Agent/Runner owns execution. */
export async function buildAgentDeps(
  deps: ExecutionDeps, configuration: AgentConfiguration, agentName: string, recordUsage: RecordUsageFn,
  origin: RunOrigin, signal?: AbortSignal, callMcpTool?: AgentDeps["callMcpTool"],
  runtime?: RuntimeTurnPersistence,
): Promise<AgentDeps> {
  if (configuration.parameters.modelRouting !== undefined && typeof configuration.parameters.modelRouting !== "boolean") throw new ValidationError("Agent model routing must be a boolean");
  const routingConfigured = configuration.parameters.modelRouting !== undefined;
  const modelRoutingPolicy = routingConfigured ? await deps.getCallRoutingPolicy?.() ?? structuredClone(DEFAULT_CALL_ROUTING_POLICY) : undefined;
  if (modelRoutingPolicy) runtime?.checkBinding(MODEL_ROUTING_POLICY_BINDING, runtimeFingerprint(modelRoutingPolicy));
  const common = { channel: deps.channel, callRouting: routingConfigured ? deps.callRouting : undefined,
    modelRoutingPolicy,
    createToolSchemaValidator: deps.createToolSchemaValidator, recordUsage, loadSkillContent: buildSkillLoader(createSkillReader(deps)) };
  if (origin.backgroundTask) return common;
  const imageModel = resolveImageModel(configuration, agentName);
  return {
    ...common,
    ...(callMcpTool ? { callMcpTool } : {}),
    canDelegate: (configuration.subagentList?.length ?? 0) > 0,
    loadAgent: (name, request) => prepareSubagent(deps, configuration, name, request, recordUsage, origin, runtime),
    generateImage: buildImageGenerator(deps, imageModel, agentName, recordUsage, signal),
    editImage: buildImageEditor(deps, imageModel, agentName, recordUsage, signal),
    fetchUrl: buildUrlFetcher(deps, configuration),
    saveFile: buildFileSaver(deps),
    fileTool: buildFileTool(deps, agentName, origin, signal),
    audioTools: configuration.parameters.audioProcessing ? await deps.audioTools?.(agentName, origin) : undefined,
    workspaceTool: configuration.parameters.workspaceTools ? await deps.workspaceTool?.(agentName, origin) : undefined,
    readSlack: await buildSlackReader(deps, configuration, agentName),
  };
}

/** Resolve only a requested target; unused bindings open no connections and spend no tokens. */
export async function prepareSubagent(
  deps: ExecutionDeps, parent: AgentConfiguration, name: string, task: AgentTask,
  recordUsage: RecordUsageFn, parentOrigin: RunOrigin,
  runtime?: RuntimeTurnPersistence,
): Promise<PreparedAgent> {
  task.signal?.throwIfAborted();
  const ref = parent.subagentList?.find((entry) => entry.name === name);
  if (!ref) throw new ValidationError(`Agent '${name}' is not connected to the current Agent settings`);
  if (parentOrigin.ancestry.includes(name)) throw new ValidationError(`Delegating to '${name}' would create a cycle`);
  if (parentOrigin.ancestry.length >= MAX_SUBAGENT_DEPTH) throw new ValidationError(`Subagent depth limit (${MAX_SUBAGENT_DEPTH}) reached`);
  const agent = await deps.agents.get(name);
  if (!agent) throw new ValidationError(`Agent '${name}' was not found`);
  const configuration = agent.configuration;
  if (!configuration) throw new ValidationError(`Agent '${name}' has no Agent configuration`);
  runtime?.checkBinding(`${task.invocationId ?? name}/configuration`, runtimeFingerprint(configuration));
  if (deps.unknownModelPolicy) assertModelsPriceable(await deps.unknownModelPolicy(), configuration);
  await assertWithinCostLimit(deps, agent);
  const origin = descend(parentOrigin, name);
  const message = task.transcript ? `Conversation context:\n${task.transcript}\n\nRequest:\n${task.message}` : task.message;
  const userMessage = {
    role: "user" as const,
    content: task.images.length ? [{ type: "text" as const, text: message }, ...task.images.map((image) => ({ type: "image_url" as const, image_url: { url: imageDataUrl(image) } }))] : message,
  };
  const baseInput = {
    agentName: agent.name, model: configuration.model, fallbackModel: configuration.fallbackModel,
    systemPrompt: configuration.systemPrompt, parameters: toEngineParameters(configuration),
    now: runClock(deps), ...callerFor({ configuration, caller: origin.caller }),
    maxTurn: Math.min(configuration.maxTurn ?? 50, task.maxTurns ?? 50),
    signal: task.signal, messages: [userMessage],
  };
  const memory = await prepareMemoryForRun(deps, { configuration, query: task.message, signal: task.signal, origin });
  const resolved = await resolveRunTools(deps, configuration, task.signal, discoveryQueries(configuration, [task.message], memory.input.remembered), origin, recordUsage);
  try {
    runtime?.checkBinding(`${task.invocationId ?? name}/tools`, runtimeFingerprint([resolved.mcp.signature, resolved.subagents, resolved.skills]));
    const childDeps = await buildAgentDeps(deps, resolved.configuration, name, recordUsage, origin, task.signal, resolved.mcp.callMcpTool, runtime);
    return {
      deps: childDeps,
      input: { ...baseInput, ...memory.input, skills: resolved.skills, subagents: resolved.subagents, mcpTools: resolved.mcp.mcpTools, mcpServers: resolved.mcp.mcpServers, canDispatch: false },
      warnings: [...resolved.warnings, ...memory.warnings],
      close: () => closeMcp(resolved.mcp.close),
    };
  } catch (error) { await closeMcp(resolved.mcp.close); throw error; }
}
