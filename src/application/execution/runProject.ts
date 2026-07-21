/**
 * Execution use cases — the composition point that resolves a version's skills,
 * MCP tools and subagents from repositories, runs the LLM engine, and records
 * usage. Route handlers import EXACTLY `executeVersion`, `executeVersionStream`
 * and `executeAgent` from here; keep these signatures stable.
 *
 * The concrete OpenAI-compatible channel is the default, but `ExecutionDeps`
 * exposes an optional `channel` so tests can inject a fake.
 */

import type { ExternalAgentRepository } from "@/domain/agent/repository";
import type { LlmChannel } from "@/domain/llm/channel";
import type { ChatMessageInput, EngineChunk, EngineParameters, RunResult } from "@/domain/llm/types";
import type { McpRepository } from "@/domain/mcp/repository";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import type { Project, SubagentRef, Version } from "@/domain/project/types";
import type { SkillRepository } from "@/domain/skill/repository";
import type { UsageRepository } from "@/domain/usage/repository";
import { channel as defaultChannel } from "@/infrastructure/llm/channel";
import { imageChannel as defaultImageChannel } from "@/infrastructure/llm/imageChannel";
import type { ImageChannel } from "@/domain/llm/imageChannel";
import { calculateImageCost, getModelConfig, MODEL_CONFIGS } from "@/domain/llm/models";
import { ToolManager } from "@/infrastructure/mcp/toolManager";
import { decryptHeadersForOutbound } from "@/lib/secret-encryption";
import { recordUsage } from "@/application/usage/recordUsage";
import * as engine from "@/application/llm/engine";

export interface ExecutionDeps {
  versions: VersionRepository;
  projects: ProjectRepository;
  skills: SkillRepository;
  mcps: McpRepository;
  externalAgents: ExternalAgentRepository;
  usage: UsageRepository;
  /** Injectable channel; defaults to the real OpenAI-compatible client. */
  channel?: LlmChannel;
  /** Injectable image channel; defaults to the real Images API client. */
  imageChannel?: ImageChannel;
}

export interface ExecuteVersionInput {
  project: Project;
  version: Version;
  variables?: Record<string, string>;
  /** Prior OpenAI-shaped messages; `messages` is the route-layer alias. */
  extraMessages?: unknown[];
  messages?: unknown[];
}

export interface ExecuteAgentInput {
  project: Project;
  version: Version;
  /** OpenAI-shaped message history from the route/chat boundary. */
  messages: unknown[];
  userEmail?: string;
}

function toEngineParameters(version: Version): EngineParameters {
  const p = version.parameters;
  const params: EngineParameters = {};
  if (p.temperature !== undefined) {
    params.temperature = p.temperature;
  }
  if (p.maxTokens !== undefined) {
    params.maxTokens = p.maxTokens;
  }
  if (p.reasoningEffort !== undefined) {
    params.reasoningEffort = p.reasoningEffort;
  }
  if (p.structuredOutput !== undefined) {
    params.structuredOutput = p.structuredOutput;
  }
  if (p.jsonSchema !== undefined) {
    params.jsonSchema = p.jsonSchema;
  }
  return params;
}

function bindUsage(deps: ExecutionDeps): engine.RecordUsageFn {
  return (record) => recordUsage(deps.usage, record);
}

// --- Single-shot version execution -----------------------------------------

export async function executeVersion(
  deps: ExecutionDeps,
  input: ExecuteVersionInput,
): Promise<RunResult> {
  const channel = deps.channel ?? defaultChannel;
  return engine.runPrompt(
    { channel, recordUsage: bindUsage(deps) },
    {
      projectName: input.project.name,
      model: input.version.model,
      fallbackModel: input.version.fallbackModel,
      systemPrompt: input.version.systemPrompt,
      userPromptTemplate: input.version.userPromptTemplate,
      variables: input.variables,
      extraMessages: (input.extraMessages ?? input.messages) as ChatMessageInput[] | undefined,
      parameters: toEngineParameters(input.version),
    },
  );
}

export async function* executeVersionStream(
  deps: ExecutionDeps,
  input: ExecuteVersionInput,
): AsyncGenerator<EngineChunk> {
  const channel = deps.channel ?? defaultChannel;
  yield* engine.runPromptStream(
    { channel, recordUsage: bindUsage(deps) },
    {
      projectName: input.project.name,
      model: input.version.model,
      fallbackModel: input.version.fallbackModel,
      systemPrompt: input.version.systemPrompt,
      userPromptTemplate: input.version.userPromptTemplate,
      variables: input.variables,
      extraMessages: (input.extraMessages ?? input.messages) as ChatMessageInput[] | undefined,
      parameters: toEngineParameters(input.version),
    },
  );
}

// --- Agent execution --------------------------------------------------------

export async function* executeAgent(
  deps: ExecutionDeps,
  input: ExecuteAgentInput,
): AsyncGenerator<EngineChunk> {
  const agentDeps = await buildAgentDeps(deps, input.version, input.project.name);
  const [skills, subagents, mcp] = await Promise.all([
    resolveSkills(deps, input.version.skillList),
    resolveSubagents(deps, input.version.subagentList),
    buildMcpTools(deps, input.version),
  ]);
  agentDeps.callMcpTool = mcp.callMcpTool;

  yield* engine.runAgent(agentDeps, {
    projectName: input.project.name,
    model: input.version.model,
    fallbackModel: input.version.fallbackModel,
    systemPrompt: input.version.systemPrompt,
    messages: input.messages as ChatMessageInput[],
    parameters: toEngineParameters(input.version),
    maxTurn: input.version.maxTurn,
    skills,
    subagents,
    mcpTools: mcp.mcpTools,
  });
}

/** Assemble the injected engine dependencies for an agent run. */
async function buildAgentDeps(
  deps: ExecutionDeps,
  version: Version,
  projectName: string,
): Promise<engine.AgentDeps> {
  const channel = deps.channel ?? defaultChannel;
  return {
    channel,
    recordUsage: bindUsage(deps),
    loadSkillContent: buildSkillLoader(deps),
    runSubagent: buildSubagentRunner(deps, version.subagentList),
    generateImage: buildImageGenerator(deps, projectName),
  };
}

/** Default image model: the first registry entry with the imageGeneration capability. */
const DEFAULT_IMAGE_MODEL = MODEL_CONFIGS.find((m) => m.capabilities.imageGeneration)?.id;

function buildImageGenerator(
  deps: ExecutionDeps,
  projectName: string,
): engine.AgentDeps["generateImage"] {
  if (!DEFAULT_IMAGE_MODEL || !getModelConfig(DEFAULT_IMAGE_MODEL)) {
    return undefined;
  }
  const model = DEFAULT_IMAGE_MODEL;
  const imageChannel = deps.imageChannel ?? defaultImageChannel;
  return async (prompt, size, quality) => {
    const result = await imageChannel.generateImage({ model, prompt, size, quality });
    const costUsd = calculateImageCost(model, result.usage);
    await deps.usage
      .record({
        projectName,
        date: new Date().toISOString().slice(0, 10),
        model,
        calls: 1,
        inputTokens: result.usage.textInputTokens + result.usage.imageInputTokens,
        outputTokens: result.usage.imageOutputTokens,
        costUsd,
      })
      .catch(() => {});
    return { b64: result.b64, mimeType: result.mimeType };
  };
}

async function resolveSkills(
  deps: ExecutionDeps,
  skillList: string[] | undefined,
): Promise<engine.SkillInfo[]> {
  const result: engine.SkillInfo[] = [];
  for (const name of skillList ?? []) {
    const skill = await deps.skills.get(name);
    result.push({ name, description: skill?.description ?? "" });
  }
  return result;
}

async function resolveSubagents(
  deps: ExecutionDeps,
  subagentList: SubagentRef[] | undefined,
): Promise<engine.SubagentInfo[]> {
  const result: engine.SubagentInfo[] = [];
  for (const ref of subagentList ?? []) {
    let description = "";
    if (ref.type === "remote") {
      const agent = await deps.externalAgents.get(ref.name);
      description = agent?.description ?? "";
    } else {
      const project = await deps.projects.get(ref.name);
      description = project?.description ?? "";
    }
    result.push({ name: ref.name, description, type: ref.type });
  }
  return result;
}

function buildSkillLoader(
  deps: ExecutionDeps,
): (skillName: string, filePath?: string) => Promise<string> {
  // Skills store their full markdown in `content`; there is no per-file tree,
  // so filePath is accepted for signature compatibility but not resolved.
  return async (skillName) => {
    const skill = await deps.skills.get(skillName);
    if (!skill) {
      return `Error: Skill '${skillName}' not found in database.`;
    }
    return skill.content ?? "";
  };
}

async function buildMcpTools(
  deps: ExecutionDeps,
  version: Version,
): Promise<{
  mcpTools: import("@/domain/llm/channel").ChannelToolDef[];
  callMcpTool?: (name: string, args: Record<string, unknown>) => Promise<string>;
}> {
  const mcpList = version.mcpList ?? [];
  if (mcpList.length === 0) {
    return { mcpTools: [] };
  }
  const servers = [];
  for (const name of mcpList) {
    const mcp = await deps.mcps.get(name);
    if (!mcp) {
      continue;
    }
    servers.push({
      name: mcp.name,
      url: mcp.url,
      headers: decryptHeadersForOutbound(mcp.headers),
    });
  }

  const reserved = new Set<string>();
  if ((version.skillList ?? []).length > 0) {
    reserved.add(engine.SKILL_TOOL_NAME);
  }
  if ((version.subagentList ?? []).length > 0) {
    reserved.add(engine.TRANSFER_TOOL_NAME);
  }

  const toolManager = new ToolManager(servers, reserved);
  await toolManager.init();
  return {
    mcpTools: toolManager.tools,
    callMcpTool: (name, args) => toolManager.callTool(name, args),
  };
}

function buildSubagentRunner(
  deps: ExecutionDeps,
  subagentList: SubagentRef[] | undefined,
): NonNullable<engine.AgentDeps["runSubagent"]> {
  const refByName = new Map((subagentList ?? []).map((ref) => [ref.name, ref]));
  return async function* runSubagent(agentName, message, turn, maxTurn) {
    const ref = refByName.get(agentName);
    if (!ref) {
      yield { author: agentName, error: `Unknown agent '${agentName}'.` };
      return "";
    }
    if (ref.type === "remote") {
      return yield* runRemoteSubagent(deps, agentName, message);
    }
    return yield* runLocalSubagent(deps, agentName, message, turn, maxTurn);
  };
}

async function* runLocalSubagent(
  deps: ExecutionDeps,
  agentName: string,
  message: string,
  turn: number,
  maxTurn: number,
): AsyncGenerator<EngineChunk, string> {
  const project = await deps.projects.get(agentName);
  if (!project) {
    yield { author: agentName, error: `Agent project '${agentName}' not found.` };
    return "";
  }
  const versionName = project.publishedVersion;
  const version = versionName ? await deps.versions.get(project.name, versionName) : null;
  if (!version) {
    yield { author: agentName, error: `Agent '${agentName}' has no published version.` };
    return "";
  }

  const [skills, subagents, mcp, childDeps] = await Promise.all([
    resolveSkills(deps, version.skillList),
    resolveSubagents(deps, version.subagentList),
    buildMcpTools(deps, version),
    buildAgentDeps(deps, version, project.name),
  ]);
  childDeps.callMcpTool = mcp.callMcpTool;

  let text = "";
  for await (const chunk of engine.runAgent(childDeps, {
    projectName: project.name,
    model: version.model,
    fallbackModel: version.fallbackModel,
    systemPrompt: version.systemPrompt,
    messages: [{ role: "user", content: message }],
    parameters: toEngineParameters(version),
    maxTurn: version.maxTurn ?? maxTurn,
    startTurn: turn,
    skills,
    subagents,
    mcpTools: mcp.mcpTools,
  })) {
    if (chunk.delta?.content) {
      text += chunk.delta.content;
    }
    // Re-author child chunks with the subagent's name for the preview UI.
    yield { ...chunk, author: agentName };
  }
  return text;
}

async function* runRemoteSubagent(
  deps: ExecutionDeps,
  agentName: string,
  message: string,
): AsyncGenerator<EngineChunk, string> {
  const agent = await deps.externalAgents.get(agentName);
  if (!agent) {
    yield { author: agentName, error: `Remote agent '${agentName}' not found.` };
    return "";
  }
  const headers = decryptHeadersForOutbound(agent.headers);
  let text = "";
  try {
    const response = await fetch(agent.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ messages: [{ role: "user", content: message }], stream: false }),
    });
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    text = data.choices?.[0]?.message?.content ?? "";
  } catch (error) {
    yield { author: agentName, error: error instanceof Error ? error.message : String(error) };
    return "";
  }
  if (text) {
    yield { author: agentName, delta: { content: text } };
  }
  return text;
}
