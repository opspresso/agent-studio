/**
 * Execution use cases — the composition point that resolves a version's skills,
 * MCP tools and subagents from repositories, runs the LLM engine, and records
 * usage. Route handlers import EXACTLY `executeVersion`, `executeVersionStream`
 * and `executeAgent` from here; keep these signatures stable.
 *
 * The concrete OpenAI-compatible channel is the default, but `ExecutionDeps`
 * exposes an optional `channel` so tests can inject a fake.
 */

import type { EngineChunk, RunResult } from "@/domain/llm/types";
import { createUsageAggregator, recordUsage } from "@/application/usage/recordUsage";
import * as engine from "@/application/llm/engine";
import { withRunDeadline } from "@/shared/runDeadline";
import { actorKey as toActorKey, type RunOrigin } from "@/domain/execution/actor";
import { openRun } from "./runBracket";
import type { ExecuteAgentInput, ExecuteProjectInput, ExecuteVersionInput, ExecutionDeps } from "./deps";
import { createSkillReader, resolveRunTools } from "./bindings";
import { closeMcp } from "./mcpTools";
import { buildAgentDeps } from "./subagentRunner";
import { createTraceRecorder, finishTrace, sampledTraceRecorder } from "./traceLifecycle";
import { runClock, runStrategyFor, toEngineParameters } from "./deps";

export type {
  ExecutionDeps,
  ExecuteAgentInput,
  ExecuteProjectInput,
  ExecuteVersionInput,
};
export type { PromptPreview, PromptPreviewMessage } from "./deps";
export { previewPrompt } from "./promptPreview";
export { runStrategyFor, type RunStrategy } from "./deps";

function bindUsage(deps: ExecutionDeps, actor: string | undefined): engine.RecordUsageFn {
  return (record) => recordUsage(deps.usage, { ...record, ...(actor ? { actor } : {}) });
}

// --- Single-shot version execution -----------------------------------------

export async function executeVersion(
  deps: ExecutionDeps,
  input: ExecuteVersionInput,
): Promise<RunResult> {
  const channel = deps.channel;
  const actorKey = input.actor ? toActorKey(input.actor) : undefined;
  // Before the recorder: a run refused by the cost guard leaves no trace, no
  // metric and no usage — it never started.
  const bracket = await openRun(deps, input.project, input.actor);
  const recorder = sampledTraceRecorder(deps, input);
  let failed = false;
  try {
    const result = await engine.runPrompt(
      { channel, recordUsage: bindUsage(deps, actorKey) },
      {
        projectName: input.project.name,
        model: input.version.model,
        fallbackModel: input.version.fallbackModel,
        systemPrompt: input.version.systemPrompt,
        userPromptTemplate: input.version.userPromptTemplate,
        variables: input.variables,
        extraMessages: input.extraMessages ?? input.messages,
        parameters: toEngineParameters(input.version),
        now: runClock(deps),
        signal: withRunDeadline(input.signal),
      },
    );
    recorder?.observeResult(result);
    await finishTrace(recorder);
    return result;
  } catch (error) {
    // A caller that hung up is a cancellation, not a failure of the run.
    failed = !input.signal?.aborted;
    await finishTrace(recorder, error);
    throw error;
  } finally {
    // `runPrompt` awaits its own usage recording, so the settle inside `close`
    // already sees this run's spend.
    await bracket.close({ failed });
  }
}

export async function* executeVersionStream(
  deps: ExecutionDeps,
  input: ExecuteVersionInput,
): AsyncGenerator<EngineChunk> {
  const channel = deps.channel;
  const actorKey = input.actor ? toActorKey(input.actor) : undefined;
  const bracket = await openRun(deps, input.project, input.actor);
  const recorder = sampledTraceRecorder(deps, input);
  let thrown: unknown;
  let completed = false;
  try {
    for await (const chunk of engine.runPromptStream(
      { channel, recordUsage: bindUsage(deps, actorKey) },
      {
        projectName: input.project.name,
        model: input.version.model,
        fallbackModel: input.version.fallbackModel,
        systemPrompt: input.version.systemPrompt,
        userPromptTemplate: input.version.userPromptTemplate,
        variables: input.variables,
        extraMessages: input.extraMessages ?? input.messages,
        parameters: toEngineParameters(input.version),
        now: runClock(deps),
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
    await bracket.close({ failed: thrown !== undefined });
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
  if (runStrategyFor(input.project) === "agent") {
    return executeAgent(deps, {
      project: input.project,
      version: input.version,
      messages: input.messages,
      ...(input.actor ? { actor: input.actor } : {}),
      signal: input.signal,
    });
  }
  return executeVersionStream(deps, {
    project: input.project,
    version: input.version,
    variables: input.variables,
    messages: input.messages,
    ...(input.actor ? { actor: input.actor } : {}),
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
  // The actor is the run's, not the turn's: every model call this loop makes —
  // including the ones a subagent transfer makes on another project — was caused
  // by whoever started it.
  const origin: RunOrigin = {
    ancestry: [input.project.name],
    ...(input.actor ? { actor: input.actor } : {}),
  };
  const usage = createUsageAggregator(deps.usage, input.actor && toActorKey(input.actor));
  const bracket = await openRun(deps, input.project, input.actor);
  const recorder = deps.traces
    ? createTraceRecorder(deps.traces, input.project, input.version, input.messages.length, origin)
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
    const readSkill = createSkillReader(deps);
    // Pinned for the whole run, subagents included: every prompt this run
    // assembles has to agree on when "now" is, and a parent and a child landing
    // on different dates across a midnight boundary is the exact confusion the
    // clock exists to remove. The pinned deps travel down the transfer chain.
    const startedAt = runClock(deps);
    const runDeps: ExecutionDeps = { ...deps, now: () => startedAt };
    const agentDeps = await buildAgentDeps(
      runDeps,
      input.version,
      input.project.name,
      usage.record,
      origin,
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
      now: startedAt,
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
    // The flush comes first: an agent run's usage is buffered until here, so a
    // settle before it would be reading a total that excludes this whole run.
    await usage.flush();
    await bracket.close({ failed: thrown !== undefined });
    await finishTrace(recorder, thrown, !completed && thrown === undefined);
  }
}
