import type { AgentConfiguration, AgentParameters, McpBinding, SubagentRef } from "@/domain/agent/types";
import type { AgentRepository } from "@/domain/agent/repository";
import type { SkillRepository } from "@/domain/skill/repository";
import type { McpRepository } from "@/domain/mcp/repository";
import { getModelConfig } from "@/domain/llm/models";
import { ValidationError } from "@/application/errors";
import { userMayAccessAgent } from "./agentUseCases";
import { agentModelRejectReason } from "./modelCompatibility";
import { log } from "@/shared/logger";

export type AgentConfigurationInput = Omit<AgentConfiguration, "agentName">;

/**
 * Registry lookups an Agent's references are checked against. A dangling
 * reference degrades silently at run time (an unknown skill loads as an empty
 * description, an unknown subagent yields a tool error), so a typo would only
 * surface as a subtly worse answer — catch it at the write boundary instead.
 */
export interface ConfigurationRefRepos {
  skills: Pick<SkillRepository, "get">;
  mcps: Pick<McpRepository, "get">;
  /** Local subagents are other agents. */
  agents: Pick<AgentRepository, "get">;
}

/** The reference lists as they appear on an Agent. */
interface ConfigurationRefs {
  mcpList?: McpBinding[];
  skillList?: string[];
  subagentList?: SubagentRef[];
}

const subagentKey = (ref: SubagentRef): string => ref.name;

/**
 * What the Agent already referenced. Both checks below look only at what an
 * edit *adds*, so an Agent stays editable after the world around it changed.
 */
function alreadyReferenced(existing?: ConfigurationRefs) {
  return {
    mcps: new Set((existing?.mcpList ?? []).map((binding) => binding.name)),
    skills: new Set(existing?.skillList ?? []),
    subagents: new Set((existing?.subagentList ?? []).map(subagentKey)),
  };
}

/**
 * Reject a list that names the same reference twice. Subagents because the
 * transfer tools address agents by name, so a duplicate is unaddressable; MCP
 * bindings because a duplicate opens the server's session twice and the second
 * row silently overwrites the first everywhere the run keys by server name (the
 * prompt's server table, the binding's tool selection); skills because a
 * duplicate is a duplicate row in the prompt's table. The console's pickers
 * cannot produce any of these — the API can, so the same write boundary that
 * checks references catches them.
 */
export function assertUniqueReferences(refs: ConfigurationRefs): void {
  const firstDuplicate = (names: readonly string[]): string | undefined => {
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) {
        return name;
      }
      seen.add(name);
    }
    return undefined;
  };
  const agent = firstDuplicate((refs.subagentList ?? []).map((ref) => ref.name));
  if (agent) {
    throw new ValidationError(
      `Agent name "${agent}" is used more than once; connected agents must have unique names.`,
    );
  }
  const mcp = firstDuplicate((refs.mcpList ?? []).map((binding) => binding.name));
  if (mcp) {
    throw new ValidationError(
      `MCP server "${mcp}" is bound more than once; a server can be bound once per Agent.`,
    );
  }
  const skill = firstDuplicate(refs.skillList ?? []);
  if (skill) {
    throw new ValidationError(
      `Skill "${skill}" is bound more than once; a skill can be bound once per Agent.`,
    );
  }
}

/**
 * Reject references that do not resolve. Only entries absent from `existing`
 * are checked: an Agent whose skill or MCP server was deleted afterwards must
 * still be editable, otherwise deleting a registry entry would strand every
 * Agent that used it.
 */
export async function assertReferencesExist(
  refs: ConfigurationRefRepos,
  next: ConfigurationRefs,
  existing?: ConfigurationRefs,
): Promise<void> {
  const { mcps: knownMcps, skills: knownSkills, subagents: knownSubagents } =
    alreadyReferenced(existing);

  const checks: Array<Promise<string | null>> = [
    ...(next.mcpList ?? [])
      .filter((binding) => !knownMcps.has(binding.name))
      .map(async ({ name }) =>
        (await refs.mcps.get(name)) ? null : `MCP server "${name}" does not exist`,
      ),
    ...(next.skillList ?? [])
      .filter((name) => !knownSkills.has(name))
      .map(async (name) =>
        (await refs.skills.get(name)) ? null : `Skill "${name}" does not exist`,
      ),
    ...(next.subagentList ?? [])
      .filter((ref) => !knownSubagents.has(subagentKey(ref)))
      .map(async (ref) => {
        return (await refs.agents.get(ref.name)) ? null : `Agent "${ref.name}" does not exist`;
      }),
  ];

  const missing = (await Promise.all(checks)).filter((message): message is string => message !== null);
  if (missing.length > 0) {
    throw new ValidationError(missing.join("; "));
  }
}

/**
 * Reject binding a local subagent the editor may not access. A local
 * subagent runs another agent inside this one's runs, so binding one is the
 * strongest form of reading it — a private agent would otherwise be
 * reachable through any public agent that named it. Only *added* refs are
 * checked, like the existence check above: an Agent stays editable after a
 * agent it already bound went private, and the run-time transfer is the
 * platform's own composition, like the owner's token. A ref that does not
 * resolve is `assertReferencesExist`'s to report, not this one's.
 */
export async function assertSubavailableAgentsAccessible(
  refs: ConfigurationRefRepos,
  next: ConfigurationRefs,
  userEmail: string,
  existing?: ConfigurationRefs,
): Promise<void> {
  const known = alreadyReferenced(existing).subagents;
  for (const ref of next.subagentList ?? []) {
    if (known.has(subagentKey(ref))) {
      continue;
    }
    const agent = await refs.agents.get(ref.name);
    if (agent && !(await userMayAccessAgent(agent, userEmail))) {
      throw new ValidationError(
        `Agent "${ref.name}" is private; ask its owner for an invite before binding it as an agent.`,
      );
    }
  }
}

/** Reject an imageModel that is unknown or lacks the imageGeneration capability. */
export function assertValidImageModel(parameters: AgentParameters): void {
  if (parameters.imageModel && !getModelConfig(parameters.imageModel)?.capabilities.imageGeneration) {
    throw new ValidationError(`Model does not support image generation: ${parameters.imageModel}`);
  }
}

/** Warn (non-blocking) when an Agent references a model missing from the catalog. */
export function warnUnknownCatalogModel(agentName: string, model: string): void {
  if (!getModelConfig(model)) {
    log.warn(
      "agent",
      `${agentName}: model "${model}" is not in the catalog; usage will be recorded with $0 cost`,
    );
  }
}

/**
 * Reject capability mismatches for catalog models. Unknown/custom ids stay on
 * the warn-only path — a mismatch on a KNOWN model is a misconfiguration, not
 * a catalog lag.
 */
export function assertAgentModelType(model: string): void {
  const cfg = getModelConfig(model);
  if (!cfg) {
    return;
  }
  const reason = agentModelRejectReason(cfg);
  if (reason === "tools") {
    throw new ValidationError(
      `Model does not support tool calling required by agents: ${model}`,
    );
  }
  if (reason === "type") {
    throw new ValidationError(
      `Model type does not support Agents: ${model}`,
    );
  }
}

export function assertModelSupports(model: string, parameters: AgentParameters): void {
  const cfg = getModelConfig(model);
  if (!cfg) {
    return;
  }
  assertAgentModelType(model);
  if (parameters.structuredOutput && !cfg.capabilities.structuredOutput) {
    throw new ValidationError(`Model does not support structured output: ${model}`);
  }
  if (parameters.reasoningTrace && !cfg.capabilities.reasoning) {
    throw new ValidationError(`Model does not produce reasoning to record: ${model}`);
  }
}
