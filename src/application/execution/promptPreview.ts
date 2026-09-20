/** Rendering what a run would send, without dispatching the model. */

import type { Project, AgentConfiguration } from "@/domain/project/types";
import type { RunActor, RunCaller } from "@/domain/execution/actor";
import * as engine from "@/application/runtime";
import type { ExecutionDeps, PromptPreview } from "./deps";
import { callerFor, runClock } from "./deps";
import { discoveryQueries, resolveRunTools } from "./bindings";
import { noRecallTargetWarning, prepareMemoryForRun, recallTargets } from "./memoryRecall";
import { closeMcp } from "./mcpTools";
import { buildAgentDeps } from "./agentBindings";

/**
 * Assemble the Agent's current editor draft using the same capabilities as a run.
 * MCP discovery and optional recall are real reads; connections close before return.
 * PII is not masked in this preview, which reports that limitation when enabled.
 */
export async function previewPrompt(
  deps: ExecutionDeps,
  input: {
    project: Project;
    configuration: AgentConfiguration;
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
     * — the Agent's `callerContext` opt-in — because a preview that showed
     * the block unconditionally would be as wrong as one that never showed it.
     */
    caller?: RunCaller;
    /** The signed-in user whose identity is sent to bound MCP servers. */
    actor?: RunActor;
  },
): Promise<PromptPreview> {
  const { project, configuration } = input;
  const warnings: string[] = [];
  if (configuration.parameters.piiFiltering) {
    warnings.push(
      "PII filtering is on: emails, phone numbers, Korean registration numbers and card numbers are replaced with tokens before dispatch.",
    );
  }

  if (
    configuration.parameters.memoryRecall &&
    !input.message?.trim()
  ) {
    warnings.push(
      "Memory recall is on, but the preview has no request to recall with; recalled context and any capabilities it would discover are not shown.",
    );
  }

  const origin = input.actor ? { actor: input.actor } : undefined;
  const memory = input.message?.trim()
    ? await prepareMemoryForRun(deps, {
        configuration,
        query: input.message,
        signal: input.signal,
        ...(origin ? { origin } : {}),
      })
    : { input: {}, warnings: [], asked: 0, failed: 0 };
  const resolved = await resolveRunTools(
    deps,
    configuration,
    input.signal,
    discoveryQueries(
      configuration,
      input.message === undefined ? [] : [input.message],
      memory.input.remembered,
    ),
    origin,
  );
  try {
    // The same deps a run is given: whether the image section and the image
    // tools appear is decided from them, not from the Agent alone.
    const agentDeps = await buildAgentDeps(
      deps,
      // As widened by discovery, so the preview stands for the run it describes
      // rather than the Agent as saved.
      resolved.configuration,
      project.name,
      async () => {},
      // Resolve actor-gated capabilities without executing them.
      { ...origin, ancestry: [project.name] },
    );
    // Without a preview request, recall performs no query. Still report missing
    // recall bindings so the author can fix them before running the Agent.
    const missingMemory =
      !input.message?.trim() &&
      configuration.parameters.memoryRecall &&
      recallTargets(resolved.mcp, configuration).length === 0
        ? { warnings: [noRecallTargetWarning()] }
        : { warnings: [] };
    const { systemPrompt, tools } = engine.assembleAgentRun(agentDeps, {
      blockedTools: configuration.parameters.policy?.blockedTools,
      ...(configuration.systemPrompt !== undefined ? { systemPrompt: configuration.systemPrompt } : {}),
      // No messages: a preview stands before the first turn, like a fresh run
      // with nothing attached.
      skills: resolved.skills,
      subagents: resolved.subagents,
      mcpServers: resolved.mcp.mcpServers,
      mcpTools: resolved.mcp.mcpTools,
      // The clock a run started now would carry, so the preview does not hide a
      // line the model will read.
      now: runClock(deps),
      ...callerFor({ configuration, caller: input.caller }),
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
