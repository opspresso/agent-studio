/**
 * Execution use cases — the composition point that resolves an Agent's skills,
 * MCP tools and subagents from repositories, runs the LLM engine, and records
 * usage. Surfaces dispatch through `streamAgentExecution` / `collectAgentRun`
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
import { UpstreamError, ValidationError } from "@/application/errors";
import { settleCostLimit } from "@/application/usage/costGuard";
import { createUsageAggregator } from "@/application/usage/recordUsage";
import * as engine from "@/application/runtime";
import { runDeadlineExceeded, withRunDeadline } from "@/shared/runDeadline";
import { runEnding } from "@/application/run/runDeadline";
import { log } from "@/shared/logger";
import { actorKey as toActorKey, type RunOrigin } from "@/domain/execution/actor";
import { openRun } from "@/application/run/runBracket";
import { captureRunArtifacts } from "@/application/artifact/runArtifacts";
import { fileRefOf, type ProducedFileRef } from "@/application/artifact/producedFiles";
import type { ExecuteAgentInput, AgentRunInput, ExecutionDeps } from "./deps";
import { discoveryQueries, recentUserQueries, resolveRunTools, toolsPrepared } from "./bindings";
import { closeMcp } from "./mcpTools";
import { buildAgentDeps } from "./agentBindings";
import { createTraceRecorder, finishTrace } from "@/application/run/traceLifecycle";
import { callerFor, runClock, toEngineParameters, toRunInput } from "./deps";
import { memoryPrepared, prepareMemoryForRun } from "./memoryRecall";
import { openRuntimeSession, runtimeFingerprint } from "@/application/runtime/session";
import { DEFAULT_CALL_ROUTING_POLICY } from "@/domain/llm/callRouting";

export type {
  ExecutionDeps,
  ExecuteAgentInput,
  AgentRunInput,
};
export type { PromptPreview, PromptPreviewMessage } from "./deps";
export { previewPrompt } from "./promptPreview";
export { executeWorkspaceTask } from "./workspaceRun";

/** Every execution surface uses the Agent tool loop. */
export function streamAgentRun(deps: ExecutionDeps, input: AgentRunInput): AsyncGenerator<EngineChunk> {
  return executeAgent(deps, toRunInput(input));
}

/** The latest user request supplies capability discovery queries. */
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

/** Completion streams retain the same Agent execution and output axes. */
export function streamAgentExecution(deps: ExecutionDeps, input: AgentRunInput): AsyncGenerator<EngineChunk> {
  return streamAgentRun(deps, input);
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
 *
 * `files` is the same judgement again, arrived at later and the hard way. A
 * document a tool rendered was stored as an artifact and then dropped from
 * every collected answer — the caller received prose about a report with no
 * report attached, while the picture beside it came back inline. The reference
 * is carried here; the surface turns it into an address, because how long a
 * signature lives is the surface's question and not this one's.
 */
export interface CollectedRun extends RunResult {
  images: RunImage[];
  /** References to what the run produced as files; bytes are stripped at the bracket. */
  files: ProducedFileRef[];
  /** What the run lost, in the order it was reported, deduplicated. */
  warnings: string[];
  termination?: RunTerminationReason;
}

/**
 * Settle the thresholds of every agent this run spent on but did not open.
 *
 * A transfer is not another turn — it is a whole run on another agent, with
 * its own limits and its own usage rows. `bracket.close` settles the agent it
 * admitted and knows about no other, and `settleCostLimit` is the only thing
 * that claims the block and alert notifications. So an agent reached only
 * through transfers accrued spend, began refusing at its threshold — the child's
 * own `assertWithinCostLimit` sees to that — and told nobody, because the one
 * announcement its owner could have received was never sent.
 *
 * After the flush, for the reason the flush is before the close: the totals have
 * to include the run that just spent them.
 *
 * Telemetry, like the flush: a settle that cannot read must not turn an answer
 * already delivered into a failure.
 */
async function settleTransferred(
  deps: ExecutionDeps,
  spentOn: readonly string[],
  openedFor: string,
): Promise<void> {
  for (const name of spentOn) {
    if (name === openedFor) {
      continue;
    }
    try {
      const agent = await deps.agents.get(name);
      if (agent) {
        await settleCostLimit(deps, agent);
      }
    } catch (error) {
      log.error("cost-guard", `could not settle spend for transferred agent '${name}'`, error);
    }
  }
}

/** Drain an agent stream into a single collected answer. */
export async function collectRun(
  source: AsyncGenerator<EngineChunk>,
  model: string,
): Promise<CollectedRun> {
  let content = "";
  const images: RunImage[] = [];
  const files: ProducedFileRef[] = [];
  const warnings: string[] = [];
  const usage: UsageInfo = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  let cachedTokens = 0;
  let reasoningTokens = 0;
  // Why the run ended, as the engine announced it. Only the top level speaks
  // for the stream: an authored termination is a child's, already absorbed
  // into the parent's tool result.
  let termination: RunTerminationReason | undefined;
  for await (const chunk of source) {
    if (chunk.error) {
      // Same as the streaming path: a subagent failure is a tool error the
      // parent may still answer from, so it does not fail the request.
      if (isTopLevelChunk(chunk)) {
        // Typed, not bare. The engine wrote this sentence for a reader, and a
        // streaming caller gets to read it; thrown as a plain `Error` the
        // collected caller got "Internal server error" instead, because
        // `apiError` cannot tell an engine's message from a stack trace. The
        // same text, with the status that says the failure is upstream.
        throw new UpstreamError(chunk.error);
      }
      continue;
    }
    // What the run lost, kept alongside the answer rather than dropped. A
    // collected surface has no later frame to say it in, and every other
    // consumer of this stream — chat, Slack, the console — reports these;
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
    // agent delegates drawing, and the picture is the answer.
    if (chunk.image) {
      images.push(chunk.image);
    }
    // Files the same way, and for the same reason a child's are the run's: a
    // transferred-to agent rendering the document is how the work gets done.
    // The bytes are already gone — the bracket kept them — so this is the
    // reference a surface turns into a download.
    if (chunk.file) {
      files.push(fileRefOf(chunk.file));
    }
    // Usage counts every chunk, subagent turns included, so the reported
    // usage matches what the run actually billed.
    if (chunk.usage) {
      usage.inputTokens += chunk.usage.inputTokens;
      usage.outputTokens += chunk.usage.outputTokens;
      usage.costUsd += chunk.usage.costUsd;
      // The two subset fields are summed here rather than left off, because
      // this accumulator and the single-shot path answer the *same* endpoint:
      // built field by field, an agent's `/predict` silently dropped
      // what an `llm` agent's returned, and a caller reading either could
      // not tell a provider that reports neither from a shape that discards
      // them. Absent-not-zero, so a run nobody reported them for is unchanged.
      cachedTokens += chunk.usage.cachedTokens ?? 0;
      reasoningTokens += chunk.usage.reasoningTokens ?? 0;
    }
  }
  return {
    content,
    model,
    usage: {
      ...usage,
      ...(cachedTokens > 0 ? { cachedTokens } : {}),
      ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    },
    images,
    files,
    warnings,
    ...(termination ? { termination } : {}),
  };
}

/**
 * Single non-streaming dispatch point — {@link streamAgentExecution}'s
 * counterpart for surfaces that answer with one collected body. Two route
 * handlers each mapped strategy→executor for themselves, and the copies had
 * already diverged on the image case; the mapping is answered here once, and a
 * route only decides how to serialise the result.
 */
export async function collectAgentRun(
  deps: ExecutionDeps,
  input: AgentRunInput,
): Promise<CollectedRun> {
  return collectRun(streamAgentRun(deps, input), input.configuration.model);
}

// --- Agent execution --------------------------------------------------------

export async function* executeAgent(
  deps: ExecutionDeps,
  input: ExecuteAgentInput,
): AsyncGenerator<EngineChunk> {
  // A multi-turn agent run makes many LLM calls; accumulate their usage and
  // flush once (per agent/date/model) when the run ends, even on error.
  // The actor is the run's, not the turn's: every model call this loop makes —
  // including the ones a subagent transfer makes on another agent — was caused
  // by whoever started it.
  const origin: RunOrigin = {
    ...(input.backgroundTask ? { backgroundTask: true } : {}),
    ancestry: [input.agent.name],
    ...(input.actor ? { actor: input.actor } : {}),
    ...(input.ownerEmail ? { userEmail: input.ownerEmail } : {}),
    // Carried unconditionally, like the actor: a child is answering the same
    // person as its parent. Whether a *prompt* names them stays a per-Agent
    // question that `callerFor` answers at each engine-input boundary — this
    // run's own opt-in decides nothing for the agent it transfers to.
    ...(input.caller ? { caller: input.caller } : {}),
    // And the conversation, for the same reason: a child is answering in the
    // same thread as its parent, and a child Agent it hands off to continues
    // that thread's context rather than opening one per hop.
    ...(input.conversation ? { conversation: input.conversation } : {}),
  };
  const usage = createUsageAggregator(deps.usage, input.actor && toActorKey(input.actor));
  const bracket = await openRun(deps, input.agent, input.configuration, input.actor, {
    ...(input.ownerEmail ? { ownerEmail: input.ownerEmail } : {}),
  });
  const recorder = deps.traces
    ? createTraceRecorder(deps.traces, input.agent, input.configuration, input.messages.length, origin)
    : undefined;
  let failure: unknown;
  let completed = false;
  let closeMcpSessions: (() => Promise<void>) | undefined;
  // Compose the caller's signal with a hard deadline. Held out here because the
  // catch has to ask which of the two aborted: a caller leaving is a
  // cancellation, the deadline is this platform stopping the run.
  const runSignal = withRunDeadline(input.signal);
  try {
    input.signal?.throwIfAborted();
    // Pinned for the whole run, subagents included: every prompt this run
    // assembles has to agree on when "now" is, and a parent and a child landing
    // on different dates across a midnight boundary is the exact confusion the
    // clock exists to remove. The pinned deps travel down the transfer chain.
    const routingPolicy = await deps.getCallRoutingPolicy?.() ?? structuredClone(DEFAULT_CALL_ROUTING_POLICY);
    const runtime = deps.runtimeSessions && input.conversation?.surface === "chat" && input.actor?.kind === "user"
      ? await openRuntimeSession(deps.runtimeSessions, { sessionId: input.conversation.id, ownerEmail: input.actor.id, agentName: input.agent.name, configuration: input.configuration,
        routingPolicyFingerprint: runtimeFingerprint(routingPolicy) }, input.resumeApproval)
      : undefined;
    if (input.resumeApproval && !runtime) throw new ValidationError("Approval resumption requires a persisted chat session");
    const messages = runtime?.checkpoint?.input.messages ?? input.messages;
    const startedAt = runtime?.checkpoint?.input.now ? new Date(runtime.checkpoint.input.now) : runClock(deps);
    const runDeps: ExecutionDeps = { ...deps, now: () => startedAt, getCallRoutingPolicy: async () => routingPolicy };
    // Recall explicit bindings before discovery, so remembered associations can
    // help find the sources needed to answer the request.
    const recallStartedAt = new Date();
    // Only when the Agent asked: a run that recalls nothing spent no time
    // here, and a zero-length span on every trace would say less than none.
    const recordRecall = (
      detail: { status?: "ok" | "error"; output?: Record<string, unknown> },
    ): void => {
      if (input.configuration.parameters.memoryRecall) {
        recorder?.observePrepare("memory", recallStartedAt, detail);
      }
    };
    const memory = await (runtime?.checkpoint ? Promise.resolve({ input: { remembered: runtime.checkpoint.input.remembered }, warnings: [], asked: 0, failed: 0 }) : prepareMemoryForRun(deps, {
      configuration: input.configuration,
      origin,
      query: latestUserText(messages) ?? "",
      signal: runSignal,
    })).then(
      (ok) => {
        recordRecall(memoryPrepared(ok));
        return ok;
      },
      (error: unknown) => {
        recordRecall({ status: "error" });
        throw error;
      },
    );
    // Tools first, deps second: the dispatcher the deps carry is the one this
    // resolve produced, so the bag is complete when it is built rather than
    // patched afterwards.
    //
    // The queries are built here because this is where the request is: the
    // newest user turns are what the run is being asked for, and the Agent's
    // system prompt is what it is generally for. `resolveRunTools` ignores them
    // unless the Agent opted in.
    // Timed, because this is the run's other network stage: every bound MCP
    // server is opened and listed here, and an Agent with discovery on embeds
    // its queries and searches the catalog. The recorder bills it to a
    // `prepare` span instead of to the model that has not been called yet.
    const resolveStartedAt = new Date();
    // Recorded on both outcomes: a server that hangs until the run deadline is
    // the preparation stage most important to preserve in the trace.
    const prepared = await (async () => {
      const resolved = await resolveRunTools(
        deps,
        input.configuration,
        runSignal,
        discoveryQueries(input.configuration, recentUserQueries(messages), memory.input.remembered),
        origin,
        usage.record,
      );
      closeMcpSessions = resolved.mcp.close;
      runtime?.checkBinding("root", runtimeFingerprint([resolved.mcp.signature, resolved.subagents, resolved.skills]));
      // Assembled inside the stage that resolved them: building the dispatcher
      // reads a repository and decrypts a secret for a run with the Slack tools
      // on, and between two spans that time was billed to the model again.
      const agentDeps = await buildAgentDeps(
        runDeps,
        // What the resolve actually read, which discovery may have widened: the
        // original would offer a discovered agent and then refuse to transfer
        // to it.
        resolved.configuration,
        input.agent.name,
        usage.record,
        origin,
        runSignal,
        resolved.mcp.callMcpTool,
        runtime,
      );
      return { resolved, agentDeps };
    })().then(
      (ok) => {
        recorder?.observePrepare("tools", resolveStartedAt, {
          output: toolsPrepared(ok.resolved),
        });
        return ok;
      },
      (error: unknown) => {
        recorder?.observePrepare("tools", resolveStartedAt, { status: "error" });
        throw error;
      },
    );
    const { skills, subagents, mcp, warnings, discovered } = prepared.resolved;
    const agentDeps: engine.AgentDeps = { ...prepared.agentDeps, onSdkSpan: recorder ? (span) => recorder.observeSdkSpan(span) : undefined };
    recorder?.useSdkRuntime();
    warnings.push(...memory.warnings.filter((warning) => !warnings.includes(warning)));
    // Logged rather than yielded: a capability *found* is a gain, and the
    // warning channel is where a reader looks for what a run lost. What the run
    // then did with it shows up in its tool traffic either way.
    if (discovered.length > 0) {
      log.info("catalog", `offering ${discovered.length} discovered: ${discovered.join(", ")}`);
    }
    // Before the first token: what this run lost is part of reading its answer.
    for (const warning of warnings) {
      const chunk: EngineChunk = {
        warning,
        ...(recorder ? { traceId: recorder.traceId } : {}),
      };
      recorder?.observe(chunk);
      yield chunk;
    }
    // Wraps the engine rather than sitting above the trace recorder: what is
    // observed and yielded downstream is the chunk that already knows where its
    // bytes were kept.
    for await (const chunk of captureRunArtifacts(bracket.artifacts, engine.runAgent(agentDeps, {
      agentName: input.agent.name,
      ...(runtime ? { runtime } : {}),
      model: input.configuration.model,
      fallbackModel: input.configuration.fallbackModel,
      systemPrompt: input.configuration.systemPrompt,
      messages,
      parameters: toEngineParameters(input.configuration),
      now: startedAt,
      ...callerFor(input),
      ...memory.input,
      // Fan-out is offered here and nowhere below it. A child that could dispatch
      // would multiply the number of concurrent runs by transfer depth, and a
      // subagent run does not pass through the run bracket — so nothing but this
      // asymmetry keeps those children inside a bound.
      canDispatch: true,
      maxTurn: input.configuration.maxTurn,
      skills,
      subagents,
      mcpTools: mcp.mcpTools,
      mcpServers: mcp.mcpServers,
      signal: runSignal,
    }))) {
      recorder?.observe(chunk);
      if (runTermination(chunk) === "error") {
        failure = chunk.error;
      }
      // The run's own id on its own chunks: a subagent's chunks already carry
      // that child's trace, and until top-level chunks carried this one, a
      // consumer joining "this run" to "its trace" (the trigger firing row)
      // could only pick up the first child's id — the wrong trace.
      yield recorder && isTopLevelChunk(chunk)
        ? { ...chunk, traceId: recorder.traceId }
        : chunk;
    }
    completed = true;
  } catch (caught) {
    // Same classification as every other run path, from the one owner: a caller
    // that left ends the run as it is, the deadline ends it in its own words —
    // and a deadline that fired is a failure even when the caller had already
    // gone, which on this deployment is the ordinary case.
    const error = runEnding(caught, runSignal);
    if (runDeadlineExceeded(runSignal) || !input.signal?.aborted) {
      failure = error;
    }
    throw error;
  } finally {
    await closeMcp(closeMcpSessions);
    // The flush comes first: an agent run's usage is buffered until here, so a
    // settle before it would be reading a total that excludes this whole run.
    const spentOn = await usage.flush();
    await bracket.close({ failed: failure !== undefined });
    await settleTransferred(deps, spentOn, input.agent.name);
    await finishTrace(recorder, failure, !completed && failure === undefined);
  }
}
