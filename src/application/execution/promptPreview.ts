/** Rendering what a run would send, without dispatching it. */

import type { Project, Version } from "@/domain/project/types";
import type { RunCaller } from "@/domain/execution/actor";
import { renderTemplate } from "@/shared/template";
import { composeImagePrompt } from "@/application/image/composeImagePrompt";
import * as engine from "@/application/llm/engine";
import type { ExecutionDeps, PromptPreview, PromptPreviewMessage } from "./deps";
import { callerFor, runClock, runStrategyFor } from "./deps";
import { discoveryQueries, resolveRunTools } from "./bindings";
import { noRecallTargetWarning, recallTargets } from "./memoryRecall";
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
 * A version with `dynamicCapabilities` on searches the catalog here too, on the
 * same two queries a run uses. Skipping it would put the preview back where the
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
     * A preview is the expensive half of a run: it opens every bound MCP server
     * for discovery and embeds a catalog query. It does not go through the run
     * bracket — nothing counts it, nothing bounds how many are in flight — so
     * the connection is the only thing that can end one, and it was not passed.
     */
    signal?: AbortSignal;
    /**
     * The request to preview against, when there is one.
     *
     * Only discovery reads it — an agent run's user turn comes from the
     * conversation, and the assembled prompt below still stands before the
     * first one. But *which* capabilities a run finds depends on what it is
     * being asked, so without this the preview can only show what the system
     * prompt alone pulls in: the floor of every run rather than the shape of
     * any particular one.
     */
    message?: string;
    /**
     * Who is previewing. Reaches the prompt on the same condition a run's does
     * — the version's `callerContext` opt-in — because a preview that showed
     * the block unconditionally would be as wrong as one that never showed it.
     */
    caller?: RunCaller;
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

  if (version.parameters.memoryRecall && runStrategyFor(project) === "agent") {
    // What a run recalls depends on the request, which a preview does not have;
    // saying so keeps a prompt one block short of the real one from reading as
    // the real one.
    warnings.push(
      "Memory recall is on: a run asks its bound memory server about the request before the first token and adds what it remembers to the system prompt. The preview has no request, so the block is not shown.",
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
          // On the same opt-in a run applies. This branch used to skip the
          // question entirely, so a prompt project previewed anonymously even
          // where its version had asked to be told who is asking.
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
  const resolved = await resolveRunTools(
    deps,
    version,
    input.signal,
    discoveryQueries(version, input.message === undefined ? [] : [input.message]),
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
    const memory =
      version.parameters.memoryRecall && recallTargets(resolved.mcp).length === 0
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
      // A preview stands for a top-level run, and that is the only kind offered
      // fan-out — hiding it here would show a prompt nobody sends.
      canDispatch: true,
    });
    return {
      messages: systemPrompt ? [{ role: "system", content: systemPrompt }] : [],
      toolNames: tools.map((tool) => tool.function.name),
      tools: tools.map((tool) => tool.function),
      warnings: [...warnings, ...resolved.warnings, ...memory.warnings],
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
