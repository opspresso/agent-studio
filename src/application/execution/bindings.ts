/** Resolving a version's skills, subagents and MCP tools for one run. */

import type { SubagentRef, Version } from "@/domain/project/types";
import type { Skill } from "@/domain/skill/types";
import { loadSkillFileContent } from "@/application/skill/loadSkill";
import * as engine from "@/application/llm/engine";
import type { ExecutionDeps } from "./deps";
import { buildMcpTools, closeMcp, type ResolvedMcp } from "./mcpTools";
import { log } from "@/shared/logger";

/**
 * One read per skill per run, shared by the prompt's skill table and the `Skill`
 * tool. Without it a run fetched every connected skill's whole item (body plus
 * attachments) just to render a description, then fetched it again on each load.
 * A skill edited mid-run is not picked up, which is what consistency wants.
 */
export type SkillReader = (name: string) => Promise<Skill | null>;

export function createSkillReader(deps: ExecutionDeps): SkillReader {
  const cache = new Map<string, Promise<Skill | null>>();
  return (name) => {
    const hit = cache.get(name);
    if (hit) {
      return hit;
    }
    const pending = deps.skills.get(name);
    cache.set(name, pending);
    return pending;
  };
}

/**
 * Skills the run can actually load. A binding whose skill was deleted from the
 * registry is dropped instead of advertised with an empty description: telling
 * the model about a skill that always fails to load only buys a wasted turn.
 */
export async function resolveSkills(
  readSkill: SkillReader,
  skillList: string[] | undefined,
): Promise<{ skills: engine.SkillInfo[]; warnings: string[] }> {
  // Warnings are read off the settled results, not pushed from inside the
  // callbacks, so their order follows the version's list rather than whichever
  // repository read happened to finish first.
  const resolved = await Promise.all(
    (skillList ?? []).map(
      async (name): Promise<{ skill?: engine.SkillInfo; warning?: string }> => {
        const skill = await readSkill(name);
        if (!skill) {
          log.warn("run", `skill '${name}' is not in the registry; not offering it this run`);
          return { warning: `Skill '${name}' is no longer in the registry; it was not offered.` };
        }
        return { skill: { name, description: skill.description ?? "" } };
      },
    ),
  );
  const skills: engine.SkillInfo[] = [];
  const warnings: string[] = [];
  for (const entry of resolved) {
    if (entry.skill) {
      skills.push(entry.skill);
    }
    if (entry.warning) {
      warnings.push(entry.warning);
    }
  }
  return { skills, warnings };
}

/** Same for subagents: an unresolvable target is not offered as a transfer. */
export async function resolveSubagents(
  deps: ExecutionDeps,
  subagentList: SubagentRef[] | undefined,
): Promise<{ subagents: engine.SubagentInfo[]; warnings: string[] }> {
  const resolved = await Promise.all(
    (subagentList ?? []).map(
      async (ref): Promise<{ subagent?: engine.SubagentInfo; warning?: string }> => {
        const target =
          ref.type === "remote"
            ? await deps.externalAgents.get(ref.name)
            : await deps.projects.get(ref.name);
        if (!target) {
          log.warn(
            "run", `${ref.type} agent '${ref.name}' no longer exists; not offering it this run`,
          );
          return {
            warning: `${ref.type === "remote" ? "Remote agent" : "Agent project"} '${ref.name}' no longer exists; a transfer to it was not offered.`,
          };
        }
        return {
          subagent: { name: ref.name, description: target.description ?? "", type: ref.type },
        };
      },
    ),
  );
  const subagents: engine.SubagentInfo[] = [];
  const warnings: string[] = [];
  for (const entry of resolved) {
    if (entry.subagent) {
      subagents.push(entry.subagent);
    }
    if (entry.warning) {
      warnings.push(entry.warning);
    }
  }
  return { subagents, warnings };
}

export function buildSkillLoader(
  readSkill: SkillReader,
): (skillName: string, filePath?: string) => Promise<string> {
  return async (skillName, filePath) =>
    loadSkillFileContent(await readSkill(skillName), skillName, filePath);
}

/**
 * Resolve a version's skills, subagents and MCP tools together.
 *
 * The MCP promise is handled separately so a *sibling's* failure still releases
 * the sessions that opened: awaiting all three as a plain `Promise.all` drops
 * the tool manager on the floor, and every session it opened stays alive
 * server-side until that server times it out.
 */
export async function resolveRunTools(
  deps: ExecutionDeps,
  version: Version,
  readSkill: SkillReader,
  signal?: AbortSignal,
): Promise<{
  skills: engine.SkillInfo[];
  subagents: engine.SubagentInfo[];
  mcp: ResolvedMcp;
  /** Everything the run lost while resolving, in version-list order. */
  warnings: string[];
}> {
  const mcpPending = buildMcpTools(deps, version, signal);
  // Claim the rejection now: a sibling that rejects first would otherwise let
  // this one surface as an unhandled rejection before the catch below runs.
  const mcpSettled = mcpPending.then(
    (mcp) => ({ mcp }),
    (error: unknown) => ({ error }),
  );
  try {
    const [skills, subagents, settled] = await Promise.all([
      resolveSkills(readSkill, version.skillList),
      resolveSubagents(deps, version.subagentList),
      mcpSettled,
    ]);
    if ("error" in settled) {
      throw settled.error;
    }
    return {
      skills: skills.skills,
      subagents: subagents.subagents,
      mcp: settled.mcp,
      warnings: [...skills.warnings, ...subagents.warnings, ...settled.mcp.warnings],
    };
  } catch (error) {
    const settled = await mcpSettled;
    if ("mcp" in settled) {
      await closeMcp(settled.mcp.close);
    }
    throw error;
  }
}
