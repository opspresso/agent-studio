import { buildFileTool } from "@/application/document/fileTool";
import type { Version } from "@/domain/project/types";
import { descend, type RunOrigin } from "@/domain/execution/actor";
import { imageDataUrl } from "@/domain/llm/types";
import type { AgentDeps, AgentTask, PreparedAgent, RecordUsageFn } from "@/application/runtime/types";
import { buildPromptMessages } from "@/application/runtime/messages";
import { resolveRunnableVersion } from "@/application/project/resolveRunnableVersion";
import { assertModelsPriceable } from "@/application/run/modelPolicy";
import { assertWithinCostLimit } from "@/application/usage/costGuard";
import { ValidationError } from "@/application/errors";
import { runtimeFingerprint, type RuntimeTurnPersistence } from "@/application/runtime/session";
import { buildSkillLoader, createSkillReader, discoveryQueries, resolveRunTools } from "./bindings";
import { prepareMemoryForRun } from "./memoryRecall";
import { buildImageEditor, buildImageGenerator, resolveImageModel, runImageSubagent } from "./imageTool";
import { buildUrlFetcher } from "./urlTool";
import { buildFileSaver } from "./saveFileTool";
import { buildSlackReader } from "./slackTool";
import { runRemoteSubagent } from "./remoteAgent";
import { closeMcp } from "./mcpTools";
import { callerFor, runClock, runStrategyFor, toEngineParameters, type ExecutionDeps } from "./deps";

export const MAX_SUBAGENT_DEPTH = 5;

/** Bind Studio capabilities and credentials. SDK Agent/Runner owns execution. */
export async function buildAgentDeps(
  deps: ExecutionDeps, version: Version, projectName: string, recordUsage: RecordUsageFn,
  origin: RunOrigin, signal?: AbortSignal, callMcpTool?: AgentDeps["callMcpTool"],
  runtime?: RuntimeTurnPersistence,
): Promise<AgentDeps> {
  const common = { channel: deps.channel, createToolSchemaValidator: deps.createToolSchemaValidator, recordUsage, loadSkillContent: buildSkillLoader(createSkillReader(deps)) };
  if (origin.backgroundTask) return common;
  const imageModel = resolveImageModel(version, projectName);
  return {
    ...common,
    ...(callMcpTool ? { callMcpTool } : {}),
    canDelegate: (version.subagentList?.length ?? 0) > 0,
    loadAgent: (name, request) => prepareSubagent(deps, version, name, request, recordUsage, origin, runtime),
    generateImage: buildImageGenerator(deps, imageModel, projectName, recordUsage, signal),
    editImage: buildImageEditor(deps, imageModel, projectName, recordUsage, signal),
    fetchUrl: buildUrlFetcher(deps, version),
    saveFile: buildFileSaver(deps),
    fileTool: buildFileTool(deps, projectName, origin, signal),
    audioTools: version.parameters.audioProcessing ? await deps.audioTools?.(projectName, origin) : undefined,
    workspaceTool: await deps.workspaceTool?.(projectName, origin),
    readSlack: await buildSlackReader(deps, version, projectName),
  };
}

/** Resolve only a requested target; unused bindings open no connections and spend no tokens. */
export async function prepareSubagent(
  deps: ExecutionDeps, parent: Version, name: string, task: AgentTask,
  recordUsage: RecordUsageFn, parentOrigin: RunOrigin,
  runtime?: RuntimeTurnPersistence,
): Promise<PreparedAgent> {
  task.signal?.throwIfAborted();
  const ref = parent.subagentList?.find((entry) => entry.name === name);
  if (!ref) throw new ValidationError(`Agent '${name}' is not connected to this version`);
  if (ref.type === "remote") {
    if (task.images.length) throw new ValidationError(`Remote agent '${name}' accepts text only`);
    const target = await deps.externalAgents.get(name);
    runtime?.checkBinding(task.invocationId ?? name, runtimeFingerprint(target ? [target.name, target.url, target.protocol] : null));
    const message = task.transcript ? `Conversation context:\n${task.transcript}\n\nRequest:\n${task.message}` : task.message;
    return { kind: "action", run: () => runRemoteSubagent(deps, name, message, task.signal, parentOrigin) };
  }
  if (parentOrigin.ancestry.includes(name)) throw new ValidationError(`Delegating to '${name}' would create a cycle`);
  if (parentOrigin.ancestry.length >= MAX_SUBAGENT_DEPTH) throw new ValidationError(`Subagent depth limit (${MAX_SUBAGENT_DEPTH}) reached`);
  const project = await deps.projects.get(name);
  if (!project) throw new ValidationError(`Agent project '${name}' was not found`);
  const version = await resolveRunnableVersion(deps.versions, project);
  if (!version) throw new ValidationError(`Agent '${name}' has no published version`);
  runtime?.checkBinding(`${task.invocationId ?? name}/version`, runtimeFingerprint(version));
  if (deps.unknownModelPolicy) assertModelsPriceable(await deps.unknownModelPolicy(), version);
  await assertWithinCostLimit(deps, project);
  const origin = descend(parentOrigin, name);
  if (runStrategyFor(project) === "image") {
    return { kind: "action", run: () => runImageSubagent(deps, name, project, version, task.message, recordUsage, origin, task.signal, task.images) };
  }
  const message = task.transcript ? `Conversation context:\n${task.transcript}\n\nRequest:\n${task.message}` : task.message;
  const userMessage = {
    role: "user" as const,
    content: task.images.length ? [{ type: "text" as const, text: message }, ...task.images.map((image) => ({ type: "image_url" as const, image_url: { url: imageDataUrl(image) } }))] : message,
  };
  const baseInput = {
    projectName: project.name, model: version.model, fallbackModel: version.fallbackModel,
    systemPrompt: version.systemPrompt, parameters: toEngineParameters(version),
    now: runClock(deps), ...callerFor({ version, caller: origin.caller }),
    maxTurn: Math.min(version.maxTurn ?? 50, task.maxTurns ?? 50),
    signal: task.signal, messages: [userMessage],
  };
  if (runStrategyFor(project) === "prompt") return {
    kind: "agent", deps: { channel: deps.channel, recordUsage },
    input: { ...baseInput, maxTurn: 1, messages: buildPromptMessages({ ...baseInput, userPromptTemplate: version.userPromptTemplate, extraMessages: [userMessage] }).filter((message) => message.role !== "system") },
    warnings: [], close: async () => {},
  };
  const memory = await prepareMemoryForRun(deps, { version, query: task.message, signal: task.signal, origin });
  const resolved = await resolveRunTools(deps, version, task.signal, discoveryQueries(version, [task.message], memory.input.remembered), origin, recordUsage);
  try {
    runtime?.checkBinding(`${task.invocationId ?? name}/tools`, runtimeFingerprint([resolved.mcp.signature, resolved.subagents, resolved.skills]));
    const childDeps = await buildAgentDeps(deps, resolved.version, name, recordUsage, origin, task.signal, resolved.mcp.callMcpTool, runtime);
    return {
      kind: "agent", deps: childDeps,
      input: { ...baseInput, ...memory.input, skills: resolved.skills, subagents: resolved.subagents, mcpTools: resolved.mcp.mcpTools, mcpServers: resolved.mcp.mcpServers, canDispatch: false },
      warnings: [...resolved.warnings, ...memory.warnings],
      close: () => closeMcp(resolved.mcp.close),
    };
  } catch (error) { await closeMcp(resolved.mcp.close); throw error; }
}
