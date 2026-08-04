/**
 * Subagent transfer and the engine deps a run is assembled from. These live
 * together because they are mutually recursive: a parent builds deps to run,
 * and a local transfer builds the child's deps the same way.
 */

import { imageDataUrl } from "@/domain/llm/types";
import type { ChatMessageInput, EngineChunk } from "@/domain/llm/types";
import type { Project, SubagentRef, Version } from "@/domain/project/types";
import type { ImageBytes } from "@/domain/llm/imageChannel";
import { BlockedUrlError } from "@/domain/security/urlPolicy";
import { descend, type RunOrigin } from "@/domain/execution/actor";
import { resolveRunnableVersion } from "@/application/project/resolveRunnableVersion";
import * as engine from "@/application/llm/engine";
import type { ExecutionDeps } from "./deps";
import { runClock, runStrategyFor, toEngineParameters } from "./deps";
import { buildImageEditor, buildImageGenerator, runImageSubagent } from "./imageTool";
import { closeMcp } from "./mcpTools";
import { assertModelsPriceable } from "./modelPolicy";
import { assertWithinCostLimit } from "@/application/usage/costGuard";
import {
  buildSkillLoader,
  createSkillReader,
  resolveRunTools,
  type SkillReader,
} from "./bindings";
import { createTraceRecorder, finishTrace } from "./traceLifecycle";

/**
 * Assemble the injected engine dependencies for an agent run.
 *
 * `callMcpTool` is a parameter rather than something the caller patches on
 * afterwards. It used to be: two call sites assigned it onto the returned object,
 * which made this function return a complete-looking bag that was not one. The
 * declarations and the dispatcher then reached the engine by different routes —
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
  readSkill: SkillReader,
  signal?: AbortSignal,
  /** The run's resolved MCP dispatcher; absent when the version binds no server. */
  callMcpTool?: engine.AgentDeps["callMcpTool"],
): Promise<engine.AgentDeps> {
  const channel = deps.channel;
  return {
    channel,
    recordUsage: recordUsageFn,
    ...(callMcpTool ? { callMcpTool } : {}),
    loadSkillContent: buildSkillLoader(readSkill),
    runSubagent: buildSubagentRunner(deps, version.subagentList, recordUsageFn, origin, signal),
    generateImage: buildImageGenerator(deps, version, projectName, recordUsageFn, signal),
    editImage: buildImageEditor(deps, version, projectName, recordUsageFn, signal),
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
 * does not bound it: a child version carries its own `maxTurn`, so a child can
 * raise the ceiling its parent was running under.
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
      return yield* runRemoteSubagent(deps, agentName, withTranscript(message, transcript), signal);
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
  while (true) {
    const step = await source.next();
    if (step.done) {
      return step.value;
    }
    const chunk = step.value;
    yield {
      ...chunk,
      author: chunk.author ?? agentName,
      authorPath: [agentName, ...(chunk.authorPath ?? [])],
    };
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
  deps: ExecutionDeps,
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
        signal,
      },
    )) {
      recorder?.observe(chunk);
      if (chunk.delta?.content) {
        text += chunk.delta.content;
      }
      // Author is stamped by `authored`; this level only claims its trace id.
      yield { ...chunk, ...(recorder ? { traceId: recorder.traceId } : {}) };
    }
    completed = true;
  } catch (error) {
    thrown = error;
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
  const readSkill = createSkillReader(deps);
  const { skills, subagents, mcp, warnings } = await resolveRunTools(
    deps,
    version,
    readSkill,
    signal,
  );

  let text = "";
  let thrown: unknown;
  let completed = false;
  try {
    // Everything past the resolve is inside the try: a consumer that stops
    // reading here — or a dependency assembly that throws before the first
    // chunk — must still release the sessions the resolve above opened.
    const childDeps = await buildAgentDeps(
      deps,
      version,
      project.name,
      recordUsageFn,
      origin,
      readSkill,
      signal,
      mcp.callMcpTool,
    );
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
      // Clamped to the parent's ceiling: the child continues the parent's turn
      // counter (`startTurn`), so a child version configured with a larger
      // maxTurn would raise the limit the whole run was started under.
      maxTurn: Math.min(version.maxTurn ?? maxTurn, maxTurn),
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
      // Stamp this level's trace id so the parent's trace links to *this* run;
      // the author stays whatever produced the chunk (see `authored`).
      yield {
        ...chunk,
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

export async function* runRemoteSubagent(
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
    headers: deps.cipher.decryptHeadersForOutbound(agent.headers),
  };
  let reply;
  try {
    reply = await deps.remoteAgents.send(target, message, signal);
  } catch (error) {
    signal?.throwIfAborted();
    yield { author: agentName, error: error instanceof Error ? error.message : String(error) };
    return "";
  }
  signal?.throwIfAborted();
  if (!reply.ok) {
    yield { author: agentName, error: reply.error };
    return "";
  }
  for (const image of reply.images) {
    yield {
      author: agentName,
      image: { b64: image.b64, mimeType: image.mimeType, prompt: message },
    };
  }
  if (reply.text) {
    yield { author: agentName, delta: { content: reply.text } };
  }
  // An image-only A2A answer still has to say something the parent can act on.
  return reply.text || (reply.images.length ? `Received ${reply.images.length} generated image(s).` : "");
}
