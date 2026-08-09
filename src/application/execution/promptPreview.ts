/** Rendering what a run would send, without dispatching it. */

import type { Project, Version } from "@/domain/project/types";
import type { RunCaller } from "@/domain/execution/actor";
import { renderTemplate } from "@/shared/template";
import * as engine from "@/application/llm/engine";
import type { ExecutionDeps, PromptPreview, PromptPreviewMessage } from "./deps";
import { callerFor, runClock, runStrategyFor } from "./deps";
import { resolveRunTools } from "./bindings";
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
    warnings.push(
      "PII filtering is on: emails, phone numbers, Korean registration numbers and card numbers are replaced with tokens before dispatch.",
    );
  }

  if (runStrategyFor(project) === "image") {
    // An image run has no system prompt — the rendered template *is* the prompt,
    // and the Playground's own prompt box overrides it at run time.
    const prompt = renderTemplate(version.userPromptTemplate, input.variables ?? {}).trim();
    if (!prompt) {
      warnings.push(
        "This project's prompt template renders empty; a run would have to supply the prompt itself.",
      );
    }
    return {
      messages: prompt ? [{ role: "user", content: prompt }] : [],
      toolNames: [],
      tools: [],
      warnings,
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
    };
  }

  if (version.userPromptTemplate.trim()) {
    warnings.push(
      "An agent run does not send the user prompt template; the conversation supplies the user turn.",
    );
  }
  const resolved = await resolveRunTools(deps, version);
  try {
    // The same deps a run is given: whether the image section and the image
    // tools appear is decided from them, not from the version alone.
    const agentDeps = await buildAgentDeps(
      deps,
      version,
      project.name,
      async () => {},
      // A preview runs nothing, so it has no actor to attribute.
      { ancestry: [project.name] },
    );
    // The same assembly a run uses, not a second spelling of it. This is where
    // the two drifted: the preview omitted the caller and showed a prompt one
    // block short of what the version actually sends.
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
      warnings: [...warnings, ...resolved.warnings],
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
