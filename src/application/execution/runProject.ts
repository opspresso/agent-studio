/**
 * Execution use cases — the composition point that resolves a version's skills,
 * MCP tools and subagents from repositories, runs the LLM engine, and records
 * usage. Surfaces dispatch through `executeProjectStream` / `executeProject`
 * rather than picking an executor themselves; keep these signatures stable.
 *
 * The concrete OpenAI-compatible channel is the default, but `ExecutionDeps`
 * exposes an optional `channel` so tests can inject a fake.
 */

import { collectedWarning, isTopLevelChunk, messageText, runTermination } from "@/domain/llm/types";
import type {
  ChatMessageInput,
  EngineChunk,
  RunResult,
  RunTerminationReason,
  UsageInfo,
} from "@/domain/llm/types";
import { generateImageStream } from "@/application/image/generateImage";
import { ValidationError } from "@/application/errors";
import { createUsageAggregator, recordUsage } from "@/application/usage/recordUsage";
import * as engine from "@/application/llm/engine";
import { withRunDeadline } from "@/shared/runDeadline";
import { log } from "@/shared/logger";
import { actorKey as toActorKey, type RunOrigin } from "@/domain/execution/actor";
import type { Project } from "@/domain/project/types";
import { openRun } from "@/application/run/runBracket";
import type { ExecuteAgentInput, ExecuteProjectInput, ExecuteVersionInput, ExecutionDeps } from "./deps";
import { discoveryQueries, recentUserQueries, resolveRunTools } from "./bindings";
import { closeMcp } from "./mcpTools";
import { buildAgentDeps } from "./subagentRunner";
import { createTraceRecorder, finishTrace, sampledTraceRecorder } from "@/application/run/traceLifecycle";
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
 * Every project type as a chunk stream, image included — for a surface that
 * consumes a run generically rather than answering with a completion.
 *
 * The pair with {@link executeProjectStream} is two contracts, not a flag: which
 * function a surface calls is that surface saying whether an image project is
 * something it can run at all. `/chat/completions` calls the refusing one
 * because an image has no chat completion — there is no answer to send. The
 * webhook runner calls this one because there is: the picture is billed,
 * traced, and recorded on the firing's row, even though a row carries text and
 * the bytes stop here. A boolean deciding whether a project type is refused
 * would be the shape of the bug the refusal prevents — a name is not.
 *
 * It exists because the composition root was answering this. `triggerRunnerDeps`
 * re-encoded the strategy dispatch and mapped the input fields itself, in the
 * one file whose job is wiring; the convention it broke — "a new execution entry
 * point calls the facade rather than re-encoding the dispatch" — was already
 * written down, and the facade simply did not offer the shape a chunk consumer
 * needed. Assembling image chunks there is also how the ending went missing once.
 *
 * `ExecutionDeps` already carries everything `ImageGenerationDeps` asks for, so
 * one bag serves both branches and a caller does not choose between two.
 */
export async function* streamProjectRun(
  deps: ExecutionDeps,
  input: ExecuteProjectInput,
): AsyncGenerator<EngineChunk> {
  if (runStrategyFor(input.project) === "image") {
    // An image run's prompt is one string. A chunk consumer's history is the
    // conversation, and only its last user turn can be the thing to draw.
    const prompt = latestUserText(input.messages);
    yield* generateImageStream(deps, {
      project: input.project,
      version: input.version,
      ...(input.variables ? { variables: input.variables } : {}),
      ...(prompt ? { prompt } : {}),
      ...(input.actor ? { actor: input.actor } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return;
  }
  yield* executeProjectStream(deps, input);
}

/**
 * The newest user turn as plain text, or nothing when there is none.
 *
 * Two callers want it for different reasons and the same way. An image run
 * draws this — the version's own template is the fallback when a conversation
 * has no user turn yet — and capability discovery searches the catalog with it.
 * Text only: an image project's model is given a prompt rather than a
 * conversation, and a search query is a query.
 */
function latestUserText(messages: ChatMessageInput[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      const text = messageText(message).trim();
      return text || undefined;
    }
  }
  return undefined;
}

/**
 * Single streaming dispatch point: how a projectType runs is decided here, not
 * in each entry point. `agent` projects run the multi-turn tool loop; anything
 * else streams a single-shot completion. `image` projects are refused — they
 * generate through the dedicated generateImage use case, not a chunk stream —
 * and every image-capable surface (predict, A2A) branches to it before asking
 * here. A surface that can render one calls {@link streamProjectRun} instead.
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

/**
 * A run drained into one answer — what a surface that cannot stream receives.
 *
 * `warnings` is part of the answer, not a detail beside it. A run reports what
 * it lost as it goes (a skill no longer in the registry, an MCP server the
 * guard blocked, tools past the per-run cap, a clipped transfer transcript, a
 * child that came back empty), and a collected surface has no later frame to
 * say any of it in. Carrying it here is the same judgement `termination`
 * already made: without it, a degraded run and a clean one are the same JSON.
 */
export interface CollectedRun extends RunResult {
  images: RunImage[];
  /** What the run lost, in the order it was reported, deduplicated. */
  warnings: string[];
  termination?: RunTerminationReason;
}

/** Drain an agent stream into a single collected answer. */
export async function collectRun(
  source: AsyncGenerator<EngineChunk>,
  model: string,
): Promise<CollectedRun> {
  let content = "";
  const images: RunImage[] = [];
  const warnings: string[] = [];
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
    // What the run lost, kept alongside the answer rather than dropped. A
    // collected surface has no later frame to say it in, and every other
    // consumer of this stream — chat, Slack, A2A, the console — reports these;
    // dropping them here is what made a run that silently lost half its tools
    // indistinguishable from one that had them. `collectedWarning` owns which
    // ones count.
    const warning = collectedWarning(chunk, warnings);
    if (warning) {
      warnings.push(warning);
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
  return { content, model, usage, images, warnings, ...(termination ? { termination } : {}) };
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
): Promise<CollectedRun> {
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
  // A single-shot run accumulates nothing and resolves no bindings, so it has
  // nothing to have lost; the empty array keeps one shape for both branches.
  return { ...result, images: [], warnings: [] };
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
    //
    // The queries are built here because this is where the request is: the
    // newest user turns are what the run is being asked for, and the version's
    // system prompt is what it is generally for. `resolveRunTools` ignores them
    // unless the version opted in.
    const {
      skills,
      subagents,
      mcp,
      warnings,
      // What the resolve actually read, which discovery may have widened. The
      // dispatcher below is built from its `subagentList`, so the original would
      // offer a discovered agent and then refuse to transfer to it.
      version: runVersion,
      discovered,
    } = await resolveRunTools(
      deps,
      input.version,
      runSignal,
      discoveryQueries(input.version, recentUserQueries(input.messages)),
    );
    closeMcpSessions = mcp.close;
    const agentDeps = await buildAgentDeps(
      runDeps,
      runVersion,
      input.project.name,
      usage.record,
      origin,
      runSignal,
      mcp.callMcpTool,
    );
    // Logged rather than yielded: a capability *found* is a gain, and the
    // warning channel is where a reader looks for what a run lost. What the run
    // then did with it shows up in its tool traffic either way.
    if (discovered.length > 0) {
      log.info("catalog", `offering ${discovered.length} discovered: ${discovered.join(", ")}`);
    }
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
