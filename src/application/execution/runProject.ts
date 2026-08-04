/**
 * Execution use cases — the composition point that resolves a version's skills,
 * MCP tools and subagents from repositories, runs the LLM engine, and records
 * usage. Surfaces dispatch through `executeProjectStream` / `executeProject`
 * rather than picking an executor themselves; keep these signatures stable.
 *
 * The concrete OpenAI-compatible channel is the default, but `ExecutionDeps`
 * exposes an optional `channel` so tests can inject a fake.
 */

import { isTopLevelChunk, runTermination } from "@/domain/llm/types";
import type { EngineChunk, RunResult, RunTerminationReason, UsageInfo } from "@/domain/llm/types";
import { ValidationError } from "@/application/errors";
import { createUsageAggregator, recordUsage } from "@/application/usage/recordUsage";
import * as engine from "@/application/llm/engine";
import { withRunDeadline } from "@/shared/runDeadline";
import { actorKey as toActorKey, type RunOrigin } from "@/domain/execution/actor";
import type { Project } from "@/domain/project/types";
import { openRun } from "./runBracket";
import type { ExecuteAgentInput, ExecuteProjectInput, ExecuteVersionInput, ExecutionDeps } from "./deps";
import { resolveRunTools } from "./bindings";
import { closeMcp } from "./mcpTools";
import { buildAgentDeps } from "./subagentRunner";
import { createTraceRecorder, finishTrace, sampledTraceRecorder } from "./traceLifecycle";
import { callerFor, runClock, runStrategyFor, toEngineParameters, toRunInput } from "./deps";

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
  const bracket = await openRun(deps, input.project, input.version, input.actor);
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
        ...callerFor(input),
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
  const bracket = await openRun(deps, input.project, input.version, input.actor);
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
        ...callerFor(input),
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
 * An image project draws through the dedicated generateImage use case, and each
 * surface serialises that answer for itself. Refusing here is what keeps a
 * completion surface from silently sending it down the single-shot text path —
 * which is exactly how the two route copies of this dispatch had diverged.
 */
function imageRunRefusal(projectName: string): ValidationError {
  return new ValidationError(
    `Project "${projectName}" is an image project; it generates through its image surface, not a completion`,
  );
}

/**
 * The tool loop runs agent projects, and every other type reaching it is a
 * misdispatch rather than a degraded run.
 *
 * A prompt project's behaviour is its `userPromptTemplate`, and the loop has
 * nowhere to put one: it answers from a bare system prompt and **succeeds**,
 * which is worse than failing, because nothing about the answer says the
 * project's own configuration was skipped. An image project is the refusal
 * {@link imageRunRefusal} already makes — its model must never reach
 * chat/completions.
 *
 * The check lives here rather than at each entry point because three of the four
 * callers already had one and the fourth did not: chats
 * (`createChat`) and all three Slack paths refuse a non-agent project, while
 * `/api/projects/{name}/versions/{version}/agent` ran the loop on whatever it
 * was given. `executeProjectStream` reaches this only for agent projects, so a
 * correct dispatch never pays for it.
 */
function agentRunRefusal(project: Project): ValidationError {
  return new ValidationError(
    `Project "${project.name}" is a ${project.projectType} project; the agent tool loop runs agent projects only`,
  );
}

/**
 * Single streaming dispatch point: how a projectType runs is decided here, not
 * in each entry point. `agent` projects run the multi-turn tool loop; anything
 * else streams a single-shot completion. `image` projects are refused — they
 * generate through the dedicated generateImage use case, not a chunk stream —
 * and every image-capable surface (predict, triggers, A2A) branches to it
 * before asking here.
 */
export function executeProjectStream(
  deps: ExecutionDeps,
  input: ExecuteProjectInput,
): AsyncGenerator<EngineChunk> {
  if (runStrategyFor(input.project) === "image") {
    throw imageRunRefusal(input.project.name);
  }
  if (runStrategyFor(input.project) === "agent") {
    return executeAgent(deps, toRunInput(input));
  }
  return executeVersionStream(deps, { ...toRunInput(input), variables: input.variables });
}

/**
 * An image produced during a run. OpenAI's chat schema has no field for these,
 * so serialisers carry them as an `images` extension rather than dropping them.
 */
export interface RunImage {
  b64: string;
  mimeType: string;
  prompt?: string;
}

/** Drain an agent stream into a single collected answer. */
export async function collectRun(
  source: AsyncGenerator<EngineChunk>,
  model: string,
): Promise<RunResult & { images: RunImage[]; termination?: RunTerminationReason }> {
  let content = "";
  const images: RunImage[] = [];
  const usage: UsageInfo = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  // Why the run ended, as the engine announced it. Only the top level speaks
  // for the stream: an authored termination is a child's, already absorbed
  // into the parent's tool result.
  let termination: RunTerminationReason | undefined;
  for await (const chunk of source) {
    if (chunk.error) {
      // Same as the streaming path: a subagent failure is a tool error the
      // parent may still answer from, so it does not fail the request.
      if (isTopLevelChunk(chunk)) {
        throw new Error(chunk.error);
      }
      continue;
    }
    termination = runTermination(chunk) ?? termination;
    if (isTopLevelChunk(chunk) && chunk.delta?.content) {
      content += chunk.delta.content;
    }
    // Images are collected from subagent turns too: an image subagent is how an
    // agent project delegates drawing, and the picture is the answer.
    if (chunk.image) {
      images.push(chunk.image);
    }
    // Usage counts every chunk, subagent turns included, so the reported
    // usage matches what the run actually billed.
    if (chunk.usage) {
      usage.inputTokens += chunk.usage.inputTokens;
      usage.outputTokens += chunk.usage.outputTokens;
      usage.costUsd += chunk.usage.costUsd;
    }
  }
  return { content, model, usage, images, ...(termination ? { termination } : {}) };
}

/**
 * Single non-streaming dispatch point — {@link executeProjectStream}'s
 * counterpart for surfaces that answer with one collected body. Two route
 * handlers each mapped strategy→executor for themselves, and the copies had
 * already diverged on the image case; the mapping is answered here once, and a
 * route only decides how to serialise the result.
 */
export async function executeProject(
  deps: ExecutionDeps,
  input: ExecuteProjectInput,
): Promise<RunResult & { images: RunImage[]; termination?: RunTerminationReason }> {
  if (runStrategyFor(input.project) === "image") {
    throw imageRunRefusal(input.project.name);
  }
  if (runStrategyFor(input.project) === "agent") {
    return collectRun(executeAgent(deps, toRunInput(input)), input.version.model);
  }
  const result = await executeVersion(deps, {
    ...toRunInput(input),
    variables: input.variables,
  });
  // The termination is the engine's: `runPrompt` reads the provider's
  // finish_reason, so a response cut at the output cap is not stamped
  // "completed" here — that stamp is what once erased the difference.
  return { ...result, images: [] };
}

// --- Agent execution --------------------------------------------------------

export async function* executeAgent(
  deps: ExecutionDeps,
  input: ExecuteAgentInput,
): AsyncGenerator<EngineChunk> {
  // Before the bracket, like every other refusal that says the request was
  // wrong rather than that the platform is busy: nothing is counted or recorded.
  if (runStrategyFor(input.project) !== "agent") {
    throw agentRunRefusal(input.project);
  }
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
  const bracket = await openRun(deps, input.project, input.version, input.actor);
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
    // Pinned for the whole run, subagents included: every prompt this run
    // assembles has to agree on when "now" is, and a parent and a child landing
    // on different dates across a midnight boundary is the exact confusion the
    // clock exists to remove. The pinned deps travel down the transfer chain.
    const startedAt = runClock(deps);
    const runDeps: ExecutionDeps = { ...deps, now: () => startedAt };
    // Tools first, deps second: the dispatcher the deps carry is the one this
    // resolve produced, so the bag is complete when it is built rather than
    // patched afterwards.
    const { skills, subagents, mcp, warnings } = await resolveRunTools(
      deps,
      input.version,
      runSignal,
    );
    closeMcpSessions = mcp.close;
    const agentDeps = await buildAgentDeps(
      runDeps,
      input.version,
      input.project.name,
      usage.record,
      origin,
      runSignal,
      mcp.callMcpTool,
    );
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
      ...callerFor(input),
      // Fan-out is offered here and nowhere below it. A child that could dispatch
      // would multiply the number of concurrent runs by transfer depth, and a
      // subagent run does not pass through the run bracket — so nothing but this
      // asymmetry keeps those children inside a bound.
      canDispatch: true,
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
