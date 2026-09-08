import { buildFileTool } from "@/application/document/fileTool";
/**
 * Subagent transfer and the engine deps a run is assembled from. These live
 * together because they are mutually recursive: a parent builds deps to run,
 * and a local transfer builds the child's deps the same way.
 *
 * That recursion is why three of the functions here take the whole
 * `ExecutionDeps`: `buildAgentDeps`, `buildSubagentRunner` and
 * `runLocalSubagent` each hand the bag to one of the others, so narrowing any
 * of them narrows nothing. The two that end a chain rather than continue it say
 * what they touch, like `runImageSubagent` and `buildMcpTools` already do —
 * a remote transfer reaching no repository, no channel and no trace is worth
 * being able to read off the signature.
 */

import { imageDataUrl, isTopLevelChunk } from "@/domain/llm/types";
import type { ChatMessageInput, EngineChunk } from "@/domain/llm/types";
import type { Project, SubagentRef, Version } from "@/domain/project/types";
import type { ImageBytes } from "@/domain/llm/imageChannel";
import { BlockedUrlError } from "@/domain/security/urlPolicy";
import { conversationKey, descend, type RunOrigin } from "@/domain/execution/actor";
import { resolveRunnableVersion } from "@/application/project/resolveRunnableVersion";
import * as engine from "@/application/llm/engine";
import type { ExecutionDeps } from "./deps";
import { callerFor, runClock, runStrategyFor, toEngineParameters } from "./deps";
import {
  buildImageEditor,
  buildImageGenerator,
  resolveImageModel,
  runImageSubagent,
} from "./imageTool";
import { buildUrlFetcher } from "./urlTool";
import { buildFileSaver } from "./saveFileTool";
import { buildSlackReader } from "./slackTool";
import { closeMcp } from "./mcpTools";
import { assertModelsPriceable } from "@/application/run/modelPolicy";
import { assertWithinCostLimit } from "@/application/usage/costGuard";
import { buildSkillLoader, createSkillReader, discoveryQueries, resolveRunTools, toolsPrepared } from "./bindings";
import { memoryPrepared, prepareMemoryForRun } from "./memoryRecall";
import { log } from "@/shared/logger";
import { runEnding } from "@/application/run/runDeadline";
import { externalAgentHeadersContext } from "@/domain/security/secretContext";
import { createTraceRecorder, finishTrace } from "@/application/run/traceLifecycle";
import { runDeadlineExceeded } from "@/shared/runDeadline";

/**
 * Assemble the injected engine dependencies for an agent run.
 *
 * `callMcpTool` is a parameter rather than something the caller patches on
 * afterwards. The declarations and dispatcher must reach the engine together —
 * `mcpTools` as run input, the dispatcher as a mutation — so a third entry point
 * that forgot the second would offer the model every tool and answer every call
 * with "cannot be executed in this context". Taking it here makes that a type
 * error instead.
 */
export async function buildAgentDeps(
  deps: ExecutionDeps,
  version: Version,
  projectName: string,
  recordUsageFn: engine.RecordUsageFn,
  /** Who caused the run, and the transfer chain it sits on. */
  origin: RunOrigin,
  signal?: AbortSignal,
  /** The run's resolved MCP dispatcher; absent when the version binds no server. */
  callMcpTool?: engine.AgentDeps["callMcpTool"],
): Promise<engine.AgentDeps> {
  const channel = deps.channel;
  // Once for the run: both builtins draw with the same model, and resolving it
  // twice is what let the two disagree about reporting a stale `imageModel`.
  const imageModel = resolveImageModel(version, projectName);
  return {
    channel,
    recordUsage: recordUsageFn,
    ...(callMcpTool ? { callMcpTool } : {}),
    // Built here rather than handed in: only the loader needs this reader, and
    // a function that can construct it should not require every caller to relay it.
    loadSkillContent: buildSkillLoader(createSkillReader(deps)),
    runSubagent: buildSubagentRunner(deps, version.subagentList, recordUsageFn, origin, signal),
    generateImage: buildImageGenerator(deps, imageModel, projectName, recordUsageFn, signal),
    editImage: buildImageEditor(deps, imageModel, projectName, recordUsageFn, signal),
    // One line here covers the top-level run, every subagent run, and the
    // Playground preview: all three come through this function.
    fetchUrl: buildUrlFetcher(deps, version),
    // Storage decides, not the version: a run that can keep a file is offered
    // the tool, and one in a deployment that keeps nothing never sees it.
    saveFile: buildFileSaver(deps),
    fileTool: buildFileTool(deps, projectName, origin, signal),
    audioTools: version.parameters.audioProcessing ? await deps.audioTools?.(projectName, origin) : undefined,
    readSlack: await buildSlackReader(deps, version, projectName),
  };
}

/**
 * The child's first user turn: the transfer message, plus any images the parent
 * handed over as inline parts so a vision-capable child can look at them.
 */
export function subagentContent(message: string, images?: ImageBytes[]): ChatMessageInput["content"] {
  if (!images || images.length === 0) {
    return message;
  }
  return [
    { type: "text", text: message },
    ...images.map((image) => ({
      type: "image_url" as const,
      image_url: { url: imageDataUrl(image) },
    })),
  ];
}

/**
 * The conversation the child was not part of, then what it is being asked to do.
 *
 * Two labelled sections rather than one run-on turn: without the split a child
 * reads the last line of the transcript as the request, and a transcript that
 * ends in a question gets answered instead of the transfer message. The header
 * says whose turns these are, because nothing else in the child's context does.
 */
export function withTranscript(message: string, transcript?: string): string {
  if (!transcript) {
    return message;
  }
  return [
    "## Conversation so far",
    "",
    "Context only — you did not take part in this, and none of it is a request to you.",
    "",
    transcript,
    "",
    "## Request",
    "",
    message,
  ].join("\n");
}

/**
 * How deep a chain of local subagent transfers may go. Turn accounting alone
 * does not bound it: a child's `maxTurn` is clamped to the parent's ceiling
 * (below), but a cycle of transfers would still spend the whole budget before
 * that ceiling said anything.
 */
export const MAX_SUBAGENT_DEPTH = 5;

export function buildSubagentRunner(
  deps: ExecutionDeps,
  subagentList: SubagentRef[] | undefined,
  recordUsageFn: engine.RecordUsageFn,
  /** Who caused the run, and the projects already on this transfer chain. */
  origin: RunOrigin,
  signal?: AbortSignal,
): NonNullable<engine.AgentDeps["runSubagent"]> {
  const refByName = new Map((subagentList ?? []).map((ref) => [ref.name, ref]));
  async function* dispatch(
    agentName: string,
    message: string,
    turn: number,
    maxTurn: number,
    images?: ImageBytes[],
    transcript?: string,
  ): AsyncGenerator<EngineChunk, string> {
    signal?.throwIfAborted();
    const ref = refByName.get(agentName);
    if (!ref) {
      yield { author: agentName, error: `Unknown agent '${agentName}'.` };
      return "";
    }
    if (ref.type === "remote") {
      if (images && images.length > 0) {
        // The outbound A2A/agent clients send text parts only, so silently
        // dropping the picture would look like a refusal to edit it.
        yield {
          author: agentName,
          error: `Agent '${agentName}' is a remote agent; images cannot be transferred to it.`,
        };
        return "";
      }
      // A remote agent takes one text message, which is exactly the shape the
      // transcript was rendered into — so it carries the conversation too.
      return yield* runRemoteSubagent(
        deps,
        agentName,
        withTranscript(message, transcript),
        signal,
        origin,
      );
    }
    // Refuse cycles and runaway nesting as tool errors, like an unknown agent:
    // the parent sees the refusal and can answer, instead of the run burning
    // tokens until the wall-clock deadline.
    if (origin.ancestry.includes(agentName)) {
      yield {
        author: agentName,
        error: `Transfer to '${agentName}' would loop (already on this chain: ${origin.ancestry.join(" -> ")}).`,
      };
      return "";
    }
    if (origin.ancestry.length >= MAX_SUBAGENT_DEPTH) {
      yield {
        author: agentName,
        error: `Subagent depth limit (${MAX_SUBAGENT_DEPTH}) reached; not transferring to '${agentName}'.`,
      };
      return "";
    }
    try {
      return yield* runLocalSubagent(
        deps,
        agentName,
        message,
        turn,
        maxTurn,
        recordUsageFn,
        // Same actor one hop down: the transfer was the parent's decision, not
        // a second person's.
        descend(origin, agentName),
        signal,
        images,
        transcript,
      );
    } catch (error) {
      // A child that throws on entry (a model that cannot take the images it was
      // handed, a broken dep) must not tear down the parent run: report it as a
      // tool error like every other refusal above, so the parent still answers.
      // Cancellation is not a refusal — it propagates.
      if (signal?.aborted) {
        throw error;
      }
      yield {
        author: agentName,
        error: `Agent '${agentName}' failed: ${error instanceof Error ? error.message : String(error)}`,
      };
      return "";
    }
  }

  return (agentName, message, turn, maxTurn, images, transcript) =>
    authored(agentName, dispatch(agentName, message, turn, maxTurn, images, transcript));
}

/**
 * Stamp the chunks flowing out of one transfer with who produced them.
 *
 * `author` keeps the *innermost* agent — a chunk from `simple-image` two levels
 * down must not surface as its middle hop — and `authorPath` accumulates the
 * chain so a consumer can render `sample-agent → simple-image`. `traceId` is
 * deliberately NOT touched here: each level stamps its own trace id on the way
 * out (see runLocalSubagent) because a parent's trace links to the run one level
 * down, not to the deepest one.
 */
export async function* authored(
  agentName: string,
  source: AsyncGenerator<EngineChunk, string>,
): AsyncGenerator<EngineChunk, string> {
  let completed = false;
  try {
    while (true) {
      const step = await source.next();
      if (step.done) {
        completed = true;
        return step.value;
      }
      const chunk = step.value;
      yield {
        ...chunk,
        author: chunk.author ?? agentName,
        authorPath: [agentName, ...(chunk.authorPath ?? [])],
      };
    }
  } finally {
    // A hand-written loop does not pass a `return()` on, and this one sits in
    // the middle of the close chain: `observeChildFailure` and
    // `runSubagentWithPii` both guard for exactly this and both are outside it.
    // Without this the cancel stops here — `runLocalSubagent` stays suspended,
    // so its `finally` never closes the child's MCP sessions or writes its
    // trace, and a run deadline firing mid-transfer leaks both.
    if (!completed) {
      await source.return("");
    }
  }
}

/**
 * A prompt project answering a transfer. Its version's user prompt template is
 * the whole of its behaviour, so it runs through the single-shot path the
 * project's own endpoint uses; the transfer message arrives as the user turn
 * after the rendered template. The template renders with no variables — a
 * transfer carries a written message, not a variable map — so a template that
 * expects them collapses those placeholders to empty, exactly as a run with
 * missing variables does.
 */
export async function* runPromptSubagent(
  deps: Pick<ExecutionDeps, "channel" | "traces" | "now">,
  project: Project,
  version: Version,
  message: string,
  recordUsageFn: engine.RecordUsageFn,
  origin: RunOrigin,
  signal?: AbortSignal,
  images?: ImageBytes[],
  transcript?: string,
): AsyncGenerator<EngineChunk, string> {
  const recorder = deps.traces
    ? createTraceRecorder(deps.traces, project, version, 1, origin)
    : undefined;
  let text = "";
  let thrown: unknown;
  let completed = false;
  try {
    for await (const chunk of engine.runPromptStream(
      { channel: deps.channel, recordUsage: recordUsageFn },
      {
        projectName: project.name,
        model: version.model,
        fallbackModel: version.fallbackModel,
        systemPrompt: version.systemPrompt,
        userPromptTemplate: version.userPromptTemplate,
        extraMessages: [
          { role: "user", content: subagentContent(withTranscript(message, transcript), images) },
        ],
        parameters: toEngineParameters(version),
        // The parent pinned this — a child must not say a different "now".
        now: runClock(deps),
        // On this version's own opt-in, from the caller the origin carried down
        // the chain. `RunOrigin` has said the caller travels since it was
        // written; nothing populated or read it, so a child that asked to be
        // told who is asking ran anonymously — the checkbox on, the block
        // missing, and nothing anywhere saying so.
        ...callerFor({ version, ...(origin.caller ? { caller: origin.caller } : {}) }),
        signal,
      },
    )) {
      recorder?.observe(chunk);
      // The same guard as `runLocalSubagent`'s, though a prompt run cannot
      // transfer and so never streams an authored chunk: two loops spelling
      // the collection differently is how the guarded one lost its guard.
      if (isTopLevelChunk(chunk) && chunk.delta?.content) {
        text += chunk.delta.content;
      }
      // Author is stamped by `authored`; this level only claims its trace id.
      yield { ...chunk, ...(recorder ? { traceId: recorder.traceId } : {}) };
    }
    completed = true;
  } catch (caught) {
    // Through the same owner as its parent's: the signal is the parent's
    // composed run signal, so a deadline that stopped both wrote the deadline's
    // sentence on one trace and the raw abort reason on the other.
    const error = runEnding(caught, signal);
    if (runDeadlineExceeded(signal) || !signal?.aborted) {
      thrown = error;
    }
    throw error;
  } finally {
    await finishTrace(recorder, thrown, !completed && thrown === undefined);
  }
  return text;
}

export async function* runLocalSubagent(
  deps: ExecutionDeps,
  agentName: string,
  message: string,
  turn: number,
  maxTurn: number,
  recordUsageFn: engine.RecordUsageFn,
  origin: RunOrigin,
  signal?: AbortSignal,
  images?: ImageBytes[],
  transcript?: string,
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
  // The run bracket owns this policy for a top-level run, and a transfer
  // deliberately never opens one — but it dispatches to the provider and books a
  // usage row exactly as its parent does, so an unpriced child leaks the same
  // money the setting exists to stop. The parent's model being registered says
  // nothing about this one's. Checked here rather than in each of the three
  // strategies below, so a fourth cannot forget it.
  if (deps.unknownModelPolicy) {
    try {
      assertModelsPriceable(await deps.unknownModelPolicy(), {
        model: version.model,
        ...(version.fallbackModel ? { fallbackModel: version.fallbackModel } : {}),
      });
    } catch (error) {
      // The transfer fails, not the run: the parent is told why and can answer
      // without this child, which is how every other refusal here behaves.
      yield {
        author: agentName,
        error: error instanceof Error ? error.message : String(error),
      };
      return "";
    }
  }
  // The child project's own daily budget, checked where its run begins.
  //
  // The bracket reads a project's spend once, when it admits a run — a backstop
  // rather than a ceiling, and re-reading between turns would buy a query per
  // turn for a bound that is approximate by design. A transfer is the exception
  // worth paying for: it is not another turn, it is a *whole run* on another
  // project, with its own tool loop and its own usage rows, and nothing else
  // ever asks whether that project may spend. A child at its threshold ran
  // anyway, because the only admission that happened was its parent's.
  try {
    await assertWithinCostLimit(deps, project);
  } catch (error) {
    yield {
      author: agentName,
      error: error instanceof Error ? error.message : String(error),
    };
    return "";
  }

  // Dispatch on the child's projectType, like the entry points do: an image
  // project generates an image — its model must never hit chat/completions.
  //
  // No transcript here, deliberately: this child's message IS its image prompt,
  // so prepending a conversation would draw the conversation. The parent is the
  // one that must fold whatever context matters into the prompt it writes.
  if (runStrategyFor(project) === "image") {
    return yield* runImageSubagent(
      deps,
      agentName,
      project,
      version,
      message,
      recordUsageFn,
      origin,
      signal,
      images,
    );
  }
  // A prompt project's behaviour lives in its user prompt template, and the
  // tool loop has nowhere to put one — running it there answers from a bare
  // system prompt instead of from the project as configured.
  if (runStrategyFor(project) !== "agent") {
    return yield* runPromptSubagent(
      deps,
      project,
      version,
      message,
      recordUsageFn,
      origin,
      signal,
      images,
      transcript,
    );
  }

  // Opened before the version's tools resolve, so the trace covers that work
  // and can record what resolving lost.
  const recorder = deps.traces
    ? createTraceRecorder(deps.traces, project, version, 1, origin)
    : undefined;

  let text = "";
  let thrown: unknown;
  let completed = false;
  let closeMcpSessions: (() => Promise<void>) | undefined;
  try {
    // The resolve is inside the try, as it is at the top level. A recorder
    // writes its row in `finish()` and nowhere else, so a resolve that threw
    // outside this block left the child with no trace at all — while the same
    // failure one level up recorded a `failed` one. Which end of a transfer a
    // failure happened at is not something the trace should decide by.
    //
    // Everything past it is inside for the older reason: a consumer that stops
    // reading — or a dependency assembly that throws before the first chunk —
    // must still release the sessions the resolve opened.
    // The transfer message is this child's whole request — `subagentContent`
    // makes it the first user turn — so it is what discovery searches with,
    // exactly as the newest user turns are at the top level. A child version that
    // opted in and was handed no queries would silently run on its bindings
    // alone, which is the difference between the two levels no one would think
    // to look for.
    // Timed like the top level's: a child opens its own MCP sessions and runs
    // its own catalog search, and billing that to its first model call is the
    // same misreading one level down.
    // The child's version decides for itself, like every other opt-in; the
    // transfer message is its whole request, so it is what the memory is asked.
    const recallStartedAt = new Date();
    const recordRecall = (
      detail: { status?: "ok" | "error"; output?: Record<string, unknown> },
    ): void => {
      if (version.parameters.memoryRecall) {
        recorder?.observePrepare("memory", recallStartedAt, detail);
      }
    };
    const memory = await prepareMemoryForRun(deps, { version, query: message, signal, origin }).then(
      (ok) => {
        recordRecall(memoryPrepared(ok));
        return ok;
      },
      (error: unknown) => {
        recordRecall({ status: "error" });
        throw error;
      },
    );
    const resolveStartedAt = new Date();
    // Recorded on both outcomes, like the top level's: the stage worth timing
    // most is the one that never finished.
    const prepared = await (async () => {
      const resolved = await resolveRunTools(
        deps,
        version,
        signal,
        discoveryQueries(version, [message], memory.input.remembered),
        origin,
        recordUsageFn,
      );
      closeMcpSessions = resolved.mcp.close;
      // Inside the stage that resolved them: the dispatcher this builds reads a
      // repository and decrypts a secret for a run with the Slack tools on.
      const childDeps = await buildAgentDeps(
        deps,
        // Widened by discovery, so a child that found an agent can transfer to it.
        resolved.version,
        project.name,
        recordUsageFn,
        origin,
        signal,
        resolved.mcp.callMcpTool,
      );
      return { resolved, childDeps };
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
    const childDeps = prepared.childDeps;
    if (discovered.length > 0) {
      // A gain, so it is logged rather than reported as a loss — see the field.
      log.info(
        "run",
        `${project.name}: offering ${discovered.length} discovered: ${discovered.join(", ")}`,
      );
    }
    warnings.push(...memory.warnings.filter((warning) => !warnings.includes(warning)));
    for (const warning of warnings) {
      const chunk: EngineChunk = { warning, ...(recorder ? { traceId: recorder.traceId } : {}) };
      recorder?.observe(chunk);
      yield chunk;
    }
    for await (const chunk of engine.runAgent(childDeps, {
      projectName: project.name,
      model: version.model,
      fallbackModel: version.fallbackModel,
      systemPrompt: version.systemPrompt,
      messages: [{ role: "user", content: subagentContent(withTranscript(message, transcript), images) }],
      // Handed on rather than re-derived: this child's only message is the
      // synthetic turn above, so deriving from it would nest one hop's
      // transcript inside the next and re-send the conversation twice over.
      ...(transcript ? { transcript } : {}),
      parameters: toEngineParameters(version),
      // The parent pinned this — a child must not say a different "now".
      now: runClock(deps),
      // See `runPromptSubagent`: this version's own `callerContext` decides,
      // and the caller comes off the origin that descended the chain.
      ...callerFor({ version, ...(origin.caller ? { caller: origin.caller } : {}) }),
      ...memory.input,
      // The child continues the parent's turn counter (`startTurn`), so its own
      // `maxTurn` is **how many turns it gets**, not a point on that counter.
      // Reading it as a point made a specialised child a parent transfers to
      // late — say `maxTurn: 10`, entered on turn 12 — trip `turn >= maxTurn`
      // on entry: it never called its model and answered `""`, which the parent
      // reported as "returned no answer". The parent's own transfer guard only
      // checks the parent's ceiling, so nothing saw it coming.
      //
      // Still clamped to that ceiling, which is the part a child may not raise:
      // the whole run was started under it.
      //
      // Truthiness rather than `=== undefined`, because `fromItem` casts
      // `item.maxTurn` blind out of JSONB: a stored `null` is typed `undefined`
      // and is not, so `turn + null === turn` would trip the child on entry —
      // the same failure from a different input. `0` is unreachable (the schema
      // says `positive()`) and would mean the same thing anyway.
      maxTurn: Math.min(version.maxTurn ? turn + version.maxTurn : maxTurn, maxTurn),
      startTurn: turn,
      skills,
      subagents,
      mcpTools: mcp.mcpTools,
      mcpServers: mcp.mcpServers,
      signal,
    })) {
      recorder?.observe(chunk);
      // Only the child's own words are its answer. A grandchild's chunks
      // travel out on this same stream — authored by `authored()` one level
      // down — and absorbing them credited this child with the grandchild's
      // words twice over: once inside the answer returned to the parent, once
      // in the tool result the nested transfer had already delivered.
      if (isTopLevelChunk(chunk) && chunk.delta?.content) {
        text += chunk.delta.content;
      }
      // Stamp this level's trace id so the parent's trace links to *this* run;
      // the author stays whatever produced the chunk (see `authored`).
      yield {
        ...chunk,
        ...(recorder ? { traceId: recorder.traceId } : {}),
      };
    }
    completed = true;
  } catch (caught) {
    // Through the same owner as its parent's: the signal a child holds is the
    // parent's composed run signal, so a deadline that stopped both wrote the
    // deadline's sentence on one trace and the raw abort reason on the other.
    const error = runEnding(caught, signal);
    if (runDeadlineExceeded(signal) || !signal?.aborted) {
      thrown = error;
    }
    throw error;
  } finally {
    await closeMcp(closeMcpSessions);
    await finishTrace(recorder, thrown, !completed && thrown === undefined);
  }
  return text;
}

export async function* runRemoteSubagent(
  deps: Pick<
    ExecutionDeps,
    "externalAgents" | "urlPolicy" | "cipher" | "remoteAgents" | "remoteConversations"
  >,
  agentName: string,
  message: string,
  signal?: AbortSignal,
  /**
   * Where the transfer came from. Its conversation, with the transferring
   * project (the chain's last element), is what a remote `contextId` is
   * remembered under; without one every transfer is its own conversation.
   */
  origin?: RunOrigin,
): AsyncGenerator<EngineChunk, string> {
  const agent = await deps.externalAgents.get(agentName);
  if (!agent) {
    yield { author: agentName, error: `Remote agent '${agentName}' not found.` };
    return "";
  }
  try {
    await deps.urlPolicy.assertAllowed(agent.url);
  } catch (error) {
    yield {
      author: agentName,
      error: error instanceof BlockedUrlError ? error.message : "Blocked remote agent URL",
    };
    return "";
  }
  const target = {
    url: agent.url,
    protocol: agent.protocol,
    headers: deps.cipher.decryptHeadersForOutbound(
      agent.headers,
      externalAgentHeadersContext(agent.name),
    ),
  };
  // The remote conversation to continue, if this one has been there before.
  // Only an A2A agent has one to continue, and only a run in a conversation
  // has a key to look it up by; a lookup that fails costs a cold start, not
  // the transfer — the read is a hint and is treated as one.
  const projectName = origin?.ancestry.at(-1);
  const key = origin?.conversation ? conversationKey(origin.conversation) : undefined;
  const continuity =
    deps.remoteConversations && agent.protocol === "a2a" && projectName && key
      ? { store: deps.remoteConversations, projectName, key }
      : undefined;
  let hint: { contextId: string; taskId?: string } | null = null;
  if (continuity) {
    try {
      hint = await continuity.store.get(continuity.projectName, agentName, continuity.key);
    } catch (error) {
      log.warn("run", `remote conversation lookup failed for '${agentName}'; starting cold`, error);
    }
  }
  let reply;
  try {
    reply = await deps.remoteAgents.send(
      target,
      message,
      signal,
      hint ? { contextId: hint.contextId, ...(hint.taskId ? { taskId: hint.taskId } : {}) } : undefined,
    );
  } catch (error) {
    signal?.throwIfAborted();
    yield { author: agentName, error: error instanceof Error ? error.message : String(error) };
    return "";
  }
  signal?.throwIfAborted();
  if (!reply.ok) {
    if (continuity && reply.continuation) {
      // Not a failure but a question: the remote parked its task to ask, and
      // the next transfer from this conversation has to answer *that* task
      // rather than open another beside it. The question reaches the parent
      // as the tool error, which is what it can relay to the person.
      try {
        await continuity.store.put(continuity.projectName, agentName, continuity.key, reply.continuation);
      } catch (error) {
        log.warn("run", `remote conversation for '${agentName}' could not be remembered`, error);
      }
    } else if (continuity && hint) {
      // A continuation that failed drops its hint: the remote may have retired
      // the context, and a wrong hint kept costs every transfer until it expires
      // where one dropped costs a single cold start. Not retried now — the remote
      // may already be working, and a second send would run the delegation twice.
      await continuity.store
        .forget(continuity.projectName, agentName, continuity.key)
        .catch((error: unknown) =>
          log.warn("run", `remote conversation for '${agentName}' could not be forgotten`, error),
        );
    }
    yield { author: agentName, error: reply.error };
    return "";
  }
  // Remembered after every successful reply, not only the first: the remote may
  // move a conversation to a new context, and the window is refreshed on use. A
  // task the conversation was parked on is answered now, so none is kept.
  if (continuity && reply.contextId) {
    try {
      await continuity.store.put(continuity.projectName, agentName, continuity.key, {
        contextId: reply.contextId,
      });
    } catch (error) {
      log.warn("run", `remote conversation for '${agentName}' could not be remembered`, error);
    }
  }
  for (const image of reply.images) {
    yield {
      author: agentName,
      // The outbound message may include a transcript added by the parent. It
      // is transport context, not the remote image's prompt, and keeping it as
      // artifact metadata would retain earlier conversation text. The remote
      // protocol does not report the actual generation prompt, so omit it.
      image: { b64: image.b64, mimeType: image.mimeType },
    };
  }
  if (reply.text) {
    yield { author: agentName, delta: { content: reply.text } };
  }
  // An image-only A2A answer still has to say something the parent can act on.
  return reply.text || (reply.images.length ? `Received ${reply.images.length} generated image(s).` : "");
}
