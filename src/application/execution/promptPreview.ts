/** Rendering what a run would send, without dispatching the model. */

import type { Project, Version } from "@/domain/project/types";
import type { RunActor, RunCaller } from "@/domain/execution/actor";
import { renderTemplate } from "@/shared/template";
import { composeImagePrompt } from "@/application/image/composeImagePrompt";
import * as engine from "@/application/llm/engine";
import type { ExecutionDeps, PromptPreview, PromptPreviewMessage } from "./deps";
import { callerFor, runClock, runStrategyFor } from "./deps";
import { discoveryQueries, resolveRunTools } from "./bindings";
import { noRecallTargetWarning, prepareMemoryForRun, recallTargets } from "./memoryRecall";
import { closeMcp } from "./mcpTools";
import { buildAgentDeps } from "./subagentRunner";

/**
 * What a version would actually send. An agent run's system prompt is assembled
 * at dispatch (skill table, connected MCP servers and their aliased tool names,
 * the transfer instructions, the image section), so the text in the editor is
 * never the text the model reads; a prompt project's template is rendered with
 * its variables. Both go through the engine's own builders, so the preview
 * cannot drift from the run it describes.
 *
 * MCP servers are contacted for real, exactly as a run does, which is the only
 * way the tool names are the true ones — so the sessions this opens are
 * released before returning.
 *
 * With a request, memory recall and dynamic capability discovery run in the
 * same order as a real run. Skipping either would put the preview back where the
 * caller block once had it: describing a smaller prompt than the version
 * actually sends, and silently — the discovered rows are the ones an author has
 * no other way to see.
 *
 * PII masking is not applied: it rewrites content per run, and what a run masks
 * depends on the turn's own text. A version with the filter on says so in its
 * warnings instead.
 */
export async function previewPrompt(
  deps: ExecutionDeps,
  input: {
    project: Project;
    version: Version;
    variables?: Record<string, string>;
    /**
     * The caller's connection, so a preview stops when they navigate away.
     *
     * A preview is the expensive half of a run: it opens bound MCP servers,
     * may call recall, and embeds catalog queries. It does not go through the run
     * bracket — nothing counts it, nothing bounds how many are in flight — so
     * the connection is the only thing that can end one, and it was not passed.
     */
    signal?: AbortSignal;
    /**
     * The request to preview against, when there is one.
     *
     * Recall and discovery read it — an agent run's user turn still comes from
     * the conversation, while the assembled prompt below stands before that
     * turn. Without this the preview can show only the floor of every run.
     */
    message?: string;
    /**
     * Who is previewing. Reaches the prompt on the same condition a run's does
     * — the version's `callerContext` opt-in — because a preview that showed
     * the block unconditionally would be as wrong as one that never showed it.
     */
    caller?: RunCaller;
    /** The signed-in user whose identity is sent to bound MCP servers. */
    actor?: RunActor;
  },
): Promise<PromptPreview> {
  const { project, version } = input;
  const warnings: string[] = [];
  if (version.parameters.piiFiltering) {
    // The filter exists on the chat paths only; an image prompt is sent as-is.
    warnings.push(
      runStrategyFor(project) === "image"
        ? "PII filtering does not apply to an image run — the prompt reaches the provider unmasked."
        : "PII filtering is on: emails, phone numbers, Korean registration numbers and card numbers are replaced with tokens before dispatch.",
    );
  }

  if (
    version.parameters.memoryRecall &&
    runStrategyFor(project) === "agent" &&
    !input.message?.trim()
  ) {
    warnings.push(
      "Memory recall is on, but the preview has no request to recall with; recalled context and any capabilities it would discover are not shown.",
    );
  }

  if (runStrategyFor(project) === "image") {
    // An image run has no system message — the version's system prompt rides in
    // front of the prompt as its persistent style, and the Playground's own
    // prompt box supplies the subject at run time (overriding the template).
    const subject = renderTemplate(version.userPromptTemplate, input.variables ?? {}).trim();
    if (!subject) {
      warnings.push(
        "This project's prompt template renders empty; a run would have to supply the prompt itself.",
      );
    }
    const prompt = composeImagePrompt(version, subject);
    return {
      messages: prompt ? [{ role: "user", content: prompt }] : [],
      toolNames: [],
      tools: [],
      warnings,
      discovered: [],
    };
  }

  if (runStrategyFor(project) !== "agent") {
    return {
      messages: toPreviewMessages(
        engine.buildPromptMessages({
          model: version.model,
          systemPrompt: version.systemPrompt,
          userPromptTemplate: version.userPromptTemplate,
          variables: input.variables,
          now: runClock(deps),
          // The same opt-in a run applies, so prompt and agent previews agree
          // about whether the caller is named.
          ...callerFor({ version, caller: input.caller }),
        }),
      ),
      toolNames: [],
      tools: [],
      warnings,
      discovered: [],
    };
  }

  if (version.userPromptTemplate.trim()) {
    warnings.push(
      "An agent run does not send the user prompt template; the conversation supplies the user turn.",
    );
  }
  const origin = input.actor ? { actor: input.actor } : undefined;
  const memory = input.message?.trim()
    ? await prepareMemoryForRun(deps, {
        version,
        query: input.message,
        signal: input.signal,
        ...(origin ? { origin } : {}),
      })
    : { input: {}, warnings: [], asked: 0, failed: 0 };
  const resolved = await resolveRunTools(
    deps,
    version,
    input.signal,
    discoveryQueries(
      version,
      input.message === undefined ? [] : [input.message],
      memory.input.remembered,
    ),
    origin,
  );
  try {
    // The same deps a run is given: whether the image section and the image
    // tools appear is decided from them, not from the version alone.
    const agentDeps = await buildAgentDeps(
      deps,
      // As widened by discovery, so the preview stands for the run it describes
      // rather than the version as saved.
      resolved.version,
      project.name,
      async () => {},
      // A preview runs nothing, so it has no actor to attribute.
      { ancestry: [project.name] },
    );
    // The same assembly a run uses, not a second spelling of it. This is where
    // the two drifted: the preview omitted the caller and showed a prompt one
    // block short of what the version actually sends.
    // Nothing is asked — a preview has no request — but whether a version with
    // recall on has anywhere to recall *from* is the one memory warning an
    // author can act on from the editor.
    const missingMemory =
      !input.message?.trim() &&
      version.parameters.memoryRecall &&
      recallTargets(resolved.mcp, version).length === 0
        ? { warnings: [noRecallTargetWarning()] }
        : { warnings: [] };
    const { systemPrompt, tools } = engine.assembleAgentRun(agentDeps, {
      ...(version.systemPrompt !== undefined ? { systemPrompt: version.systemPrompt } : {}),
      // No messages: a preview stands before the first turn, like a fresh run
      // with nothing attached.
      skills: resolved.skills,
      subagents: resolved.subagents,
      mcpServers: resolved.mcp.mcpServers,
      mcpTools: resolved.mcp.mcpTools,
      // The clock a run started now would carry, so the preview does not hide a
      // line the model will read.
      now: runClock(deps),
      ...callerFor({ version, caller: input.caller }),
      ...(memory.input.remembered ? { remembered: memory.input.remembered } : {}),
      // A preview stands for a top-level run, and that is the only kind offered
      // fan-out — hiding it here would show a prompt nobody sends.
      canDispatch: true,
    });
    return {
      messages: systemPrompt ? [{ role: "system", content: systemPrompt }] : [],
      toolNames: tools.map((tool) => tool.function.name),
      tools: tools.map((tool) => tool.function),
      warnings: [
        ...new Set([
          ...warnings,
          ...resolved.warnings,
          ...memory.warnings,
          ...missingMemory.warnings,
        ]),
      ],
      discovered: resolved.discovered,
    };
  } finally {
    await closeMcp(resolved.mcp.close);
  }
}

export function toPreviewMessages(
  messages: Array<{ role: string; content?: unknown }>,
): PromptPreviewMessage[] {
  return messages.flatMap((message) =>
    (message.role === "system" || message.role === "user") && typeof message.content === "string"
      ? [{ role: message.role, content: message.content }]
      : [],
  );
}
