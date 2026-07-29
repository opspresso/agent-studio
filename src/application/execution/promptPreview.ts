/** Rendering what a run would send, without dispatching it. */

import type { Project, Version } from "@/domain/project/types";
import { renderTemplate } from "@/application/llm/template";
import * as engine from "@/application/llm/engine";
import type { ExecutionDeps, PromptPreview, PromptPreviewMessage } from "./deps";
import { runStrategyFor } from "./deps";
import { createSkillReader, resolveRunTools } from "./bindings";
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
  input: { project: Project; version: Version; variables?: Record<string, string> },
): Promise<PromptPreview> {
  const { project, version } = input;
  const warnings: string[] = [];
  if (version.parameters.piiFiltering) {
    warnings.push(
      "PII filtering is on: emails and phone numbers are replaced with tokens before dispatch.",
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
        }),
      ),
      toolNames: [],
      warnings,
    };
  }

  if (version.userPromptTemplate.trim()) {
    warnings.push(
      "An agent run does not send the user prompt template; the conversation supplies the user turn.",
    );
  }
  const readSkill = createSkillReader(deps);
  const resolved = await resolveRunTools(deps, version, readSkill);
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
      readSkill,
    );
    const uses = engine.imagePromptUses(agentDeps, resolved.subagents);
    const systemPrompt = engine.buildAgentSystemPrompt(
      version.systemPrompt,
      resolved.skills,
      resolved.subagents,
      resolved.mcp.mcpServers,
      // No handles: a preview stands before the first message, like a fresh run
      // with nothing attached.
      { handles: [], ...uses },
    );
    const { tools } = engine.buildAgentTools(
      resolved.mcp.mcpTools,
      resolved.skills,
      resolved.subagents,
      Boolean(agentDeps.generateImage),
      uses.canEdit,
      uses.canTransfer,
    );
    return {
      messages: systemPrompt ? [{ role: "system", content: systemPrompt }] : [],
      toolNames: tools.map((tool) => tool.function.name),
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
