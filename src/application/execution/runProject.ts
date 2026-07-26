/**
 * Execution use cases — the composition point that resolves a version's skills,
 * MCP tools and subagents from repositories, runs the LLM engine, and records
 * usage. Route handlers import EXACTLY `executeVersion`, `executeVersionStream`
 * and `executeAgent` from here; keep these signatures stable.
 *
 * The concrete OpenAI-compatible channel is the default, but `ExecutionDeps`
 * exposes an optional `channel` so tests can inject a fake.
 */

import type { ChatMessageInput, EngineChunk, EngineParameters, RunResult } from "@/domain/llm/types";
import { createUsageAggregator, recordUsage } from "@/application/usage/recordUsage";
import * as engine from "@/application/llm/engine";
import { withRunDeadline } from "@/shared/runDeadline";
import { beginRun, endRun } from "@/lib/runMetrics";
import type { ExecuteAgentInput, ExecuteProjectInput, ExecuteVersionInput, ExecutionDeps } from "./deps";
import { createSkillReader, resolveRunTools } from "./bindings";
import { closeMcp } from "./mcpTools";
import { buildAgentDeps } from "./subagentRunner";
import { createTraceRecorder, finishTrace, sampledTraceRecorder } from "./traceLifecycle";
import { toEngineParameters } from "./deps";

export type {
  ExecutionDeps,
  ExecuteAgentInput,
  ExecuteProjectInput,
  ExecuteVersionInput,
};
export type { PromptPreview, PromptPreviewMessage } from "./deps";
export { previewPrompt } from "./promptPreview";

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
  beginRun();
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
  } finally {
    endRun();
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
  beginRun();
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
    endRun();
    await finishTrace(recorder, thrown, !completed && thrown === undefined);
  }
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
    ? createTraceRecorder(deps.traces, input.project, input.version, input.messages.length, [
        input.project.name,
      ])
    : undefined;
  let thrown: unknown;
  let completed = false;
  let closeMcpSessions: (() => Promise<void>) | undefined;
  beginRun();
  try {
    input.signal?.throwIfAborted();
    // Compose the caller's signal with a hard deadline; classification in the
    // catch stays keyed on `input.signal` so a deadline reads as error, a
    // caller abort as cancelled.
    const runSignal = withRunDeadline(input.signal);
    const readSkill = createSkillReader(deps);
    const agentDeps = await buildAgentDeps(
      deps,
      input.version,
      input.project.name,
      usage.record,
      [input.project.name],
      readSkill,
      runSignal,
    );
    const { skills, subagents, mcp, warnings } = await resolveRunTools(
      deps,
      input.version,
      readSkill,
      runSignal,
    );
    agentDeps.callMcpTool = mcp.callMcpTool;
    closeMcpSessions = mcp.close;
    // Before the first token: what this run lost is part of reading its answer.
    for (const warning of warnings) {
      const chunk: EngineChunk = { warning };
      recorder?.observe(chunk);
      yield chunk;
    }
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
    endRun();
    await closeMcp(closeMcpSessions);
    await usage.flush();
    await finishTrace(recorder, thrown, !completed && thrown === undefined);
  }
}
