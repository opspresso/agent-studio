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
import type { TraceRepository } from "@/domain/trace/repository";
import type { ImageChannel } from "@/domain/llm/imageChannel";
import { calculateImageCost, getModelConfig, MODEL_CONFIGS } from "@/domain/llm/models";
import { ToolManager } from "@/infrastructure/mcp/toolManager";
import { sendA2aMessage } from "@/infrastructure/a2a/client";
import { assertPublicUrl, SsrfError } from "@/infrastructure/net/ssrfGuard";
import { fetchPublicUrl } from "@/infrastructure/net/publicFetch";
import { decryptHeadersForOutbound } from "@/infrastructure/crypto/secretEncryption";
import { createUsageAggregator, recordUsage } from "@/application/usage/recordUsage";
import { resolveRunnableVersion } from "@/application/project/resolveRunnableVersion";
import { loadSkillFileContent } from "@/application/skill/loadSkill";
import * as engine from "@/application/llm/engine";
import { TraceRecorder } from "@/application/trace/recorder";
import { withRunDeadline } from "@/lib/runDeadline";

export interface ExecutionDeps {
  versions: VersionRepository;
  projects: ProjectRepository;
  skills: SkillRepository;
  mcps: McpRepository;
  externalAgents: ExternalAgentRepository;
  usage: UsageRepository;
  /** LLM channel — wired by the composition root; tests inject a fake. */
  channel: LlmChannel;
  /** Image channel — wired by the composition root; tests inject a fake. */
  imageChannel: ImageChannel;
  traces?: TraceRepository;
  traceSampleRate?: number;
}

export interface ExecuteVersionInput {
  project: Project;
  version: Version;
  variables?: Record<string, string>;
  /** Prior OpenAI-shaped messages; `messages` is the route-layer alias. */
  extraMessages?: ChatMessageInput[];
  messages?: ChatMessageInput[];
  signal?: AbortSignal;
}

export interface ExecuteAgentInput {
  project: Project;
  version: Version;
  /** OpenAI-shaped message history from the route/chat boundary. */
  messages: ChatMessageInput[];
  userEmail?: string;
  signal?: AbortSignal;
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
  params.piiFiltering = p.piiFiltering;
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
  const channel = deps.channel;
  const recorder = sampledTraceRecorder(deps, input);
  try {
    const result = await engine.runPrompt(
      { channel, recordUsage: bindUsage(deps) },
      {
        projectName: input.project.name,
        model: input.version.model,
        fallbackModel: input.version.fallbackModel,
        systemPrompt: input.version.systemPrompt,
        userPromptTemplate: input.version.userPromptTemplate,
        variables: input.variables,
        extraMessages: input.extraMessages ?? input.messages,
        parameters: toEngineParameters(input.version),
        signal: withRunDeadline(input.signal),
      },
    );
    recorder?.observeResult(result);
    await finishTrace(recorder);
    return result;
  } catch (error) {
    await finishTrace(recorder, error);
    throw error;
  }
}

export async function* executeVersionStream(
  deps: ExecutionDeps,
  input: ExecuteVersionInput,
): AsyncGenerator<EngineChunk> {
  const channel = deps.channel;
  const recorder = sampledTraceRecorder(deps, input);
  let thrown: unknown;
  let completed = false;
  try {
    for await (const chunk of engine.runPromptStream(
      { channel, recordUsage: bindUsage(deps) },
      {
        projectName: input.project.name,
        model: input.version.model,
        fallbackModel: input.version.fallbackModel,
        systemPrompt: input.version.systemPrompt,
        userPromptTemplate: input.version.userPromptTemplate,
        variables: input.variables,
        extraMessages: input.extraMessages ?? input.messages,
        parameters: toEngineParameters(input.version),
        signal: withRunDeadline(input.signal),
      },
    )) {
      recorder?.observe(chunk);
      yield chunk;
    }
    completed = true;
  } catch (error) {
    if (!input.signal?.aborted) {
      thrown = error;
    }
    throw error;
  } finally {
    await finishTrace(recorder, thrown, !completed && thrown === undefined);
  }
}

// --- Project-level dispatch --------------------------------------------------

export interface ExecuteProjectInput {
  project: Project;
  version: Version;
  variables?: Record<string, string>;
  messages: ChatMessageInput[];
  userEmail?: string;
  signal?: AbortSignal;
}

/**
 * Single streaming dispatch point: how a projectType runs is decided here, not
 * in each entry point. `agent` projects run the multi-turn tool loop; anything
 * else streams a single-shot completion. (`image` projects generate through
 * the dedicated generateImage use case, not a chunk stream.)
 */
export function executeProjectStream(
  deps: ExecutionDeps,
  input: ExecuteProjectInput,
): AsyncGenerator<EngineChunk> {
  if (input.project.projectType === "agent") {
    return executeAgent(deps, {
      project: input.project,
      version: input.version,
      messages: input.messages,
      userEmail: input.userEmail,
      signal: input.signal,
    });
  }
  return executeVersionStream(deps, {
    project: input.project,
    version: input.version,
    variables: input.variables,
    messages: input.messages,
    signal: input.signal,
  });
}

// --- Agent execution --------------------------------------------------------

export async function* executeAgent(
  deps: ExecutionDeps,
  input: ExecuteAgentInput,
): AsyncGenerator<EngineChunk> {
  // A multi-turn agent run makes many LLM calls; accumulate their usage and
  // flush once (per project/date/model) when the run ends, even on error.
  const usage = createUsageAggregator(deps.usage);
  const recorder = deps.traces
    ? createTraceRecorder(deps.traces, input.project, input.version, input.messages.length)
    : undefined;
  let thrown: unknown;
  let completed = false;
  let closeMcpSessions: (() => Promise<void>) | undefined;
  try {
    input.signal?.throwIfAborted();
    // Compose the caller's signal with a hard deadline; classification in the
    // catch stays keyed on `input.signal` so a deadline reads as error, a
    // caller abort as cancelled.
    const runSignal = withRunDeadline(input.signal);
    const agentDeps = await buildAgentDeps(
      deps,
      input.version,
      input.project.name,
      usage.record,
      [input.project.name],
      runSignal,
    );
    const [skills, subagents, mcp] = await Promise.all([
      resolveSkills(deps, input.version.skillList),
      resolveSubagents(deps, input.version.subagentList),
      buildMcpTools(deps, input.version, runSignal),
    ]);
    agentDeps.callMcpTool = mcp.callMcpTool;
    closeMcpSessions = mcp.close;
    for await (const chunk of engine.runAgent(agentDeps, {
      projectName: input.project.name,
      model: input.version.model,
      fallbackModel: input.version.fallbackModel,
      systemPrompt: input.version.systemPrompt,
      messages: input.messages,
      parameters: toEngineParameters(input.version),
      maxTurn: input.version.maxTurn,
      skills,
      subagents,
      mcpTools: mcp.mcpTools,
      mcpServers: mcp.mcpServers,
      signal: runSignal,
    })) {
      recorder?.observe(chunk);
      yield chunk;
    }
    completed = true;
  } catch (error) {
    if (!input.signal?.aborted) {
      thrown = error;
    }
    throw error;
  } finally {
    await closeMcp(closeMcpSessions);
    await usage.flush();
    await finishTrace(recorder, thrown, !completed && thrown === undefined);
  }
}

function sampledTraceRecorder(
  deps: ExecutionDeps,
  input: ExecuteVersionInput,
): TraceRecorder | undefined {
  if (!deps.traces || Math.random() >= (deps.traceSampleRate ?? 0)) {
    return undefined;
  }
  return createTraceRecorder(
    deps.traces,
    input.project,
    input.version,
    (input.extraMessages ?? input.messages ?? []).length,
  );
}

function createTraceRecorder(
  traces: TraceRepository,
  project: Project,
  version: Version,
  messageCount: number,
): TraceRecorder {
  return new TraceRecorder(traces, {
    projectName: project.name,
    versionName: version.versionName,
    projectType: project.projectType,
    model: version.model,
    messageCount,
  });
}

async function finishTrace(
  recorder: TraceRecorder | undefined,
  error?: unknown,
  cancelled = false,
): Promise<void> {
  if (!recorder) {
    return;
  }
  try {
    await recorder.finish(error, cancelled);
  } catch (traceError) {
    console.error("[trace] persistence failed", traceError);
  }
}

/** Assemble the injected engine dependencies for an agent run. */
async function buildAgentDeps(
  deps: ExecutionDeps,
  version: Version,
  projectName: string,
  recordUsageFn: engine.RecordUsageFn,
  /** Transfer chain this run sits on; the top-level run starts with itself. */
  ancestry: readonly string[],
  signal?: AbortSignal,
): Promise<engine.AgentDeps> {
  const channel = deps.channel;
  return {
    channel,
    recordUsage: recordUsageFn,
    loadSkillContent: buildSkillLoader(deps),
    runSubagent: buildSubagentRunner(deps, version.subagentList, recordUsageFn, ancestry, signal),
    generateImage: buildImageGenerator(deps, version, projectName, recordUsageFn, signal),
  };
}

/** Default image model: the first registry entry with the imageGeneration capability. */
const DEFAULT_IMAGE_MODEL = MODEL_CONFIGS.find((m) => m.capabilities.imageGeneration)?.id;

/**
 * The GenerateImage builtin is strictly opt-in per version. A stored imageModel
 * that has since left the registry falls back to the default instead of
 * disabling the tool the version opted into.
 */
function buildImageGenerator(
  deps: ExecutionDeps,
  version: Version,
  projectName: string,
  recordUsageFn: engine.RecordUsageFn,
  signal?: AbortSignal,
): engine.AgentDeps["generateImage"] {
  if (version.parameters.imageGeneration !== true) {
    return undefined;
  }
  const requested = version.parameters.imageModel;
  let model: string | undefined;
  if (requested && getModelConfig(requested)?.capabilities.imageGeneration) {
    model = requested;
  } else {
    if (requested) {
      console.warn(
        `[image] version ${projectName}/${version.versionName} requests unavailable image model "${requested}"; falling back to ${DEFAULT_IMAGE_MODEL}`,
      );
    }
    model = DEFAULT_IMAGE_MODEL;
  }
  if (!model) {
    return undefined;
  }
  const resolvedModel = model;
  const imageChannel = deps.imageChannel;
  return async (prompt, size, quality) => {
    signal?.throwIfAborted();
    const result = await imageChannel.generateImage({
      model: resolvedModel,
      prompt,
      size,
      quality,
      signal,
    });
    const costUsd = calculateImageCost(resolvedModel, result.usage);
    await recordUsageFn({
      projectName,
      model: resolvedModel,
      inputTokens: result.usage.textInputTokens + result.usage.imageInputTokens,
      outputTokens: result.usage.imageOutputTokens,
      costUsd,
    });
    return { b64: result.b64, mimeType: result.mimeType };
  };
}

async function resolveSkills(
  deps: ExecutionDeps,
  skillList: string[] | undefined,
): Promise<engine.SkillInfo[]> {
  return Promise.all(
    (skillList ?? []).map(async (name) => {
      const skill = await deps.skills.get(name);
      return { name, description: skill?.description ?? "" };
    }),
  );
}

async function resolveSubagents(
  deps: ExecutionDeps,
  subagentList: SubagentRef[] | undefined,
): Promise<engine.SubagentInfo[]> {
  return Promise.all(
    (subagentList ?? []).map(async (ref) => {
      const description =
        ref.type === "remote"
          ? ((await deps.externalAgents.get(ref.name))?.description ?? "")
          : ((await deps.projects.get(ref.name))?.description ?? "");
      return { name: ref.name, description, type: ref.type };
    }),
  );
}

function buildSkillLoader(
  deps: ExecutionDeps,
): (skillName: string, filePath?: string) => Promise<string> {
  return async (skillName, filePath) =>
    loadSkillFileContent(await deps.skills.get(skillName), skillName, filePath);
}

async function buildMcpTools(
  deps: ExecutionDeps,
  version: Version,
  signal?: AbortSignal,
): Promise<{
  mcpTools: import("@/domain/llm/channel").ChannelToolDef[];
  mcpServers: engine.McpServerInfo[];
  callMcpTool?: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** Releases the MCP sessions; call in a `finally` once the run is over. */
  close?: () => Promise<void>;
}> {
  const mcpList = version.mcpList ?? [];
  if (mcpList.length === 0) {
    return { mcpTools: [], mcpServers: [] };
  }
  const descriptionByName = new Map<string, string>();
  const resolved = await Promise.all(
    mcpList.map(async (name) => {
      const mcp = await deps.mcps.get(name);
      if (!mcp) {
        return null;
      }
      try {
        // Re-check at dispatch (like remote subagents) to narrow the DNS-rebinding
        // window; a blocked server is skipped, not fatal to the run.
        await assertPublicUrl(mcp.url);
      } catch (error) {
        console.warn(
          `Skipping MCP server '${mcp.name}': ${error instanceof SsrfError ? error.message : String(error)}`,
        );
        return null;
      }
      return mcp;
    }),
  );
  const servers = [];
  for (const mcp of resolved) {
    if (!mcp) {
      continue;
    }
    servers.push({
      name: mcp.name,
      url: mcp.url,
      headers: decryptHeadersForOutbound(mcp.headers),
    });
    descriptionByName.set(mcp.name, mcp.description ?? "");
  }

  const reserved = new Set<string>();
  if ((version.skillList ?? []).length > 0) {
    reserved.add(engine.SKILL_TOOL_NAME);
  }
  if ((version.subagentList ?? []).length > 0) {
    reserved.add(engine.TRANSFER_TOOL_NAME);
  }

  const toolManager = new ToolManager(servers, reserved, signal);
  await toolManager.init();
  const mcpServers: engine.McpServerInfo[] = [];
  for (const [serverName, toolNames] of toolManager.toolNamesByServer) {
    if (toolNames.length > 0) {
      mcpServers.push({
        name: serverName,
        description: descriptionByName.get(serverName) ?? "",
        toolNames,
      });
    }
  }
  return {
    mcpTools: toolManager.tools,
    mcpServers,
    callMcpTool: (name, args) => toolManager.callTool(name, args),
    close: () => toolManager.close(),
  };
}

/** Release MCP sessions without ever failing the run that just finished. */
async function closeMcp(close: (() => Promise<void>) | undefined): Promise<void> {
  if (!close) {
    return;
  }
  try {
    await close();
  } catch (error) {
    console.warn("[mcp] session cleanup failed", error);
  }
}

/**
 * How deep a chain of local subagent transfers may go. Turn accounting alone
 * does not bound it: a child version carries its own `maxTurn`, so a child can
 * raise the ceiling its parent was running under.
 */
const MAX_SUBAGENT_DEPTH = 5;

function buildSubagentRunner(
  deps: ExecutionDeps,
  subagentList: SubagentRef[] | undefined,
  recordUsageFn: engine.RecordUsageFn,
  /** Project names already on this transfer chain, outermost first. */
  ancestry: readonly string[],
  signal?: AbortSignal,
): NonNullable<engine.AgentDeps["runSubagent"]> {
  const refByName = new Map((subagentList ?? []).map((ref) => [ref.name, ref]));
  return async function* runSubagent(agentName, message, turn, maxTurn) {
    signal?.throwIfAborted();
    const ref = refByName.get(agentName);
    if (!ref) {
      yield { author: agentName, error: `Unknown agent '${agentName}'.` };
      return "";
    }
    if (ref.type === "remote") {
      return yield* runRemoteSubagent(deps, agentName, message, signal);
    }
    // Refuse cycles and runaway nesting as tool errors, like an unknown agent:
    // the parent sees the refusal and can answer, instead of the run burning
    // tokens until the wall-clock deadline.
    if (ancestry.includes(agentName)) {
      yield {
        author: agentName,
        error: `Transfer to '${agentName}' would loop (already on this chain: ${ancestry.join(" -> ")}).`,
      };
      return "";
    }
    if (ancestry.length >= MAX_SUBAGENT_DEPTH) {
      yield {
        author: agentName,
        error: `Subagent depth limit (${MAX_SUBAGENT_DEPTH}) reached; not transferring to '${agentName}'.`,
      };
      return "";
    }
    return yield* runLocalSubagent(
      deps,
      agentName,
      message,
      turn,
      maxTurn,
      recordUsageFn,
      [...ancestry, agentName],
      signal,
    );
  };
}

/** An image-project child generates one image from the transfer message. */
async function* runImageSubagent(
  deps: ExecutionDeps,
  agentName: string,
  project: Project,
  version: Version,
  message: string,
  recordUsageFn: engine.RecordUsageFn,
  signal?: AbortSignal,
): AsyncGenerator<EngineChunk, string> {
  const model = version.model;
  const recorder = deps.traces
    ? createTraceRecorder(deps.traces, project, version, 1)
    : undefined;
  if (!getModelConfig(model)?.capabilities.imageGeneration) {
    yield {
      author: agentName,
      error: `Agent '${agentName}' uses a model without image generation: ${model}`,
      ...(recorder ? { traceId: recorder.traceId } : {}),
    };
    await finishTrace(
      recorder,
      new Error(`Agent '${agentName}' uses a model without image generation: ${model}`),
    );
    return "";
  }
  try {
    signal?.throwIfAborted();
    const result = await deps.imageChannel.generateImage({ model, prompt: message, signal });
    const costUsd = calculateImageCost(model, result.usage);
    await recordUsageFn({
      projectName: project.name,
      model,
      inputTokens: result.usage.textInputTokens + result.usage.imageInputTokens,
      outputTokens: result.usage.imageOutputTokens,
      costUsd,
    });
    recorder?.observeResult({
      content: "",
      model,
      usage: {
        inputTokens: result.usage.textInputTokens + result.usage.imageInputTokens,
        outputTokens: result.usage.imageOutputTokens,
        costUsd,
      },
    });
    yield {
      author: agentName,
      ...(recorder ? { traceId: recorder.traceId } : {}),
      image: { b64: result.b64, mimeType: result.mimeType, prompt: message },
    };
    await finishTrace(recorder);
    return `Generated an image for: ${message}`;
  } catch (error) {
    signal?.throwIfAborted();
    yield {
      author: agentName,
      ...(recorder ? { traceId: recorder.traceId } : {}),
      error: error instanceof Error ? error.message : "image generation failed",
    };
    await finishTrace(recorder, error);
    return "";
  }
}

async function* runLocalSubagent(
  deps: ExecutionDeps,
  agentName: string,
  message: string,
  turn: number,
  maxTurn: number,
  recordUsageFn: engine.RecordUsageFn,
  ancestry: readonly string[],
  signal?: AbortSignal,
): AsyncGenerator<EngineChunk, string> {
  const project = await deps.projects.get(agentName);
  if (!project) {
    yield { author: agentName, error: `Agent project '${agentName}' not found.` };
    return "";
  }
  // Subagent transfers run published versions only — drafts never leak.
  const version = await resolveRunnableVersion(deps.versions, project);
  if (!version) {
    yield { author: agentName, error: `Agent '${agentName}' has no published version.` };
    return "";
  }

  // Dispatch on the child's projectType, like the entry points do: an image
  // project generates an image — its model must never hit chat/completions.
  if (project.projectType === "image") {
    return yield* runImageSubagent(
      deps,
      agentName,
      project,
      version,
      message,
      recordUsageFn,
      signal,
    );
  }

  const [skills, subagents, mcp, childDeps] = await Promise.all([
    resolveSkills(deps, version.skillList),
    resolveSubagents(deps, version.subagentList),
    buildMcpTools(deps, version, signal),
    buildAgentDeps(deps, version, project.name, recordUsageFn, ancestry, signal),
  ]);
  childDeps.callMcpTool = mcp.callMcpTool;
  const recorder = deps.traces
    ? createTraceRecorder(deps.traces, project, version, 1)
    : undefined;

  let text = "";
  let thrown: unknown;
  let completed = false;
  try {
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
      mcpServers: mcp.mcpServers,
      signal,
    })) {
      recorder?.observe(chunk);
      if (chunk.delta?.content) {
        text += chunk.delta.content;
      }
      // Re-author child chunks with the subagent's name for the preview UI.
      yield {
        ...chunk,
        author: agentName,
        ...(recorder ? { traceId: recorder.traceId } : {}),
      };
    }
    completed = true;
  } catch (error) {
    thrown = error;
    throw error;
  } finally {
    await closeMcp(mcp.close);
    await finishTrace(recorder, thrown, !completed && thrown === undefined);
  }
  return text;
}

const REMOTE_SUBAGENT_TIMEOUT_MS = 120_000;

async function* runRemoteSubagent(
  deps: ExecutionDeps,
  agentName: string,
  message: string,
  signal?: AbortSignal,
): AsyncGenerator<EngineChunk, string> {
  const agent = await deps.externalAgents.get(agentName);
  if (!agent) {
    yield { author: agentName, error: `Remote agent '${agentName}' not found.` };
    return "";
  }
  try {
    await assertPublicUrl(agent.url);
  } catch (error) {
    yield {
      author: agentName,
      error: error instanceof SsrfError ? error.message : "Blocked remote agent URL",
    };
    return "";
  }
  const headers = decryptHeadersForOutbound(agent.headers);
  if (agent.protocol === "a2a") {
    const result = await sendA2aMessage(agent.url, headers, message, signal);
    signal?.throwIfAborted();
    if (!result.ok) {
      yield { author: agentName, error: result.error };
      return "";
    }
    for (const image of result.images) {
      yield {
        author: agentName,
        image: { b64: image.b64, mimeType: image.mimeType, prompt: message },
      };
    }
    if (result.text) {
      yield { author: agentName, delta: { content: result.text } };
    }
    return result.text || `Received ${result.images.length} generated image(s).`;
  }
  let text = "";
  try {
    const response = await fetchPublicUrl(agent.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ messages: [{ role: "user", content: message }], stream: false }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(REMOTE_SUBAGENT_TIMEOUT_MS)])
        : AbortSignal.timeout(REMOTE_SUBAGENT_TIMEOUT_MS),
    });
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    text = data.choices?.[0]?.message?.content ?? "";
  } catch (error) {
    signal?.throwIfAborted();
    yield { author: agentName, error: error instanceof Error ? error.message : String(error) };
    return "";
  }
  if (text) {
    yield { author: agentName, delta: { content: text } };
  }
  return text;
}
