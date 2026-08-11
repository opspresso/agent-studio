/** Resolving a version's skills, subagents and MCP tools for one run. */

import type { McpBinding, SubagentRef, Version } from "@/domain/project/types";
import type { Skill } from "@/domain/skill/types";
import { loadSkillFileContent } from "@/application/skill/loadSkill";
import { searchCapabilities, type CatalogSearchDeps } from "@/application/catalog/searchCatalog";
import * as engine from "@/application/llm/engine";
import type { ExecutionDeps } from "./deps";
import { buildMcpTools, closeMcp, type McpToolDeps, type ResolvedMcp } from "./mcpTools";
import { log } from "@/shared/logger";

/**
 * One read per skill, behind the `Skill` tool.
 *
 * The tool is called repeatedly for the same skill — once for the body, then
 * once per attachment it asks for — and each call used to be its own item read.
 * A skill edited mid-run is not picked up, which is what consistency wants.
 *
 * Scoped to one agent's deps (`buildAgentDeps` builds it), so each hop of a
 * transfer chain has its own. Sharing one across the chain would save a read
 * only where a parent and a child bind the same skill *and* both load it, and
 * the way to get it there is a parameter on a signature that already carries
 * eight — not a trade worth making without a measurement asking for it.
 */
export type SkillReader = (name: string) => Promise<Skill | null>;

export function createSkillReader(deps: Pick<ExecutionDeps, "skills">): SkillReader {
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
 *
 * Reads descriptions, not skills. The prompt's table shows a name and one line,
 * and asking for the whole item to render it meant a run paid for every bound
 * skill's body and attachments before its first token — including the runs whose
 * model never called the tool, which is the case progressive disclosure exists
 * for. The body is read by {@link buildSkillLoader}, when a call asks for it.
 */
export async function resolveSkills(
  deps: Pick<ExecutionDeps, "skills">,
  skillList: string[] | undefined,
): Promise<{ skills: engine.SkillInfo[]; warnings: string[] }> {
  const names = skillList ?? [];
  if (names.length === 0) {
    return { skills: [], warnings: [] };
  }
  const described = new Map(
    (await deps.skills.describe(names)).map((entry) => [entry.name, entry.description]),
  );
  // Walked in the version's own order, so what a run reports about its bindings
  // reads in the order the version lists them.
  const skills: engine.SkillInfo[] = [];
  const warnings: string[] = [];
  for (const name of names) {
    const description = described.get(name);
    if (description === undefined) {
      log.warn("run", `skill '${name}' is not in the registry; not offering it this run`);
      warnings.push(`Skill '${name}' is no longer in the registry; it was not offered.`);
      continue;
    }
    skills.push({ name, description });
  }
  return { skills, warnings };
}

/** Same for subagents: an unresolvable target is not offered as a transfer. */
export async function resolveSubagents(
  deps: Pick<ExecutionDeps, "externalAgents" | "projects">,
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
            "run",
            `${ref.type} agent '${ref.name}' no longer exists; not offering it this run`,
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
 * How much of each kind a search may add to a run that did not bind them.
 *
 * This platform's own policy, so it sits beside the loop that spends it rather
 * than in `domain/` — nobody else imposes these numbers. They are not one
 * number because the three cost different things: a skill is a row in a table
 * whose body is read only if the model asks for it, an agent is a row and an
 * enum value, and an **MCP server is a discovery round trip before the first
 * token** plus every one of its tools competing for the per-run tool cap. The
 * server limit is low for that reason, not out of caution about relevance.
 */
const DISCOVERY_LIMITS = { skill: 5, agent: 3, mcpServer: 2 } as const;

/**
 * How much of a system prompt is used as a query.
 *
 * The opening of a system prompt says what the agent is; the rest is rules,
 * formatting and examples, which describe *how* it answers and drag the query
 * toward whatever those examples happen to mention. Embedding models also bound
 * their input, and a long prompt would spend that budget on the least
 * discriminating part.
 */
const PROMPT_QUERY_CHARS = 2000;

/** The queries a run searches the catalog with, in the order they are ranked. */
export function discoveryQueries(version: Version, request: string | undefined): string[] {
  return [version.systemPrompt.slice(0, PROMPT_QUERY_CHARS), request ?? ""].filter(
    (query) => query.trim() !== "",
  );
}

/**
 * Capabilities to offer beyond what the version bound.
 *
 * Everything here is *additive*: it returns names to append, and the caller
 * appends them after the bindings. A version's own list is never reordered,
 * filtered or truncated by this — which is the whole reason a project can turn
 * discovery on without auditing what it already relies on.
 *
 * **An MCP server that requires OAuth is never added.** Not because it could
 * not be checked, but because checking it means asking the auth provider for
 * headers, and that call refreshes tokens — with a provider that rotates
 * refresh tokens, two resolutions in one run race each other and the loser
 * stores a token the provider already revoked (`McpConnectionRepository.updateTokens`
 * says so at length). A server whose credentials are a per-project connection
 * is one somebody deliberately connected, and binding it explicitly is that
 * same deliberate act.
 */
async function discoverCapabilities(
  deps: { catalog: CatalogSearchDeps; mcps: Pick<ExecutionDeps["mcps"], "get"> },
  version: Version,
  queries: readonly string[],
): Promise<{ skillList: string[]; subagentList: SubagentRef[]; mcpList: McpBinding[]; notes: string[] }> {
  const boundSkills = new Set(version.skillList ?? []);
  const boundAgents = new Set((version.subagentList ?? []).map((ref) => ref.name));
  const boundServers = new Set((version.mcpList ?? []).map((binding) => binding.name));

  const [skills, agents, toolHits, serverHits] = await Promise.all([
    searchCapabilities(deps.catalog, queries, { kind: "skill", limit: DISCOVERY_LIMITS.skill }),
    searchCapabilities(deps.catalog, queries, { kind: "agent", limit: DISCOVERY_LIMITS.agent }),
    // Tools are what a request matches, but a server is what a run can bind —
    // so the tool index answers "which server", and the binding is the server.
    searchCapabilities(deps.catalog, queries, {
      kind: "mcpTool",
      limit: DISCOVERY_LIMITS.mcpServer * 4,
    }),
    // And the server index answers for everything the tool index cannot: a
    // server whose tools could not be listed when the catalog was built has no
    // tool rows at all, so searching tools alone makes it permanently
    // undiscoverable — which is most of the point of indexing servers
    // separately. Its listing may well succeed at dispatch (a credential fixed
    // since, a server that was down), and if it does not, the run reports it
    // like any other binding that came back empty.
    searchCapabilities(deps.catalog, queries, {
      kind: "mcpServer",
      limit: DISCOVERY_LIMITS.mcpServer,
    }),
  ]);

  const skillList = skills.map((match) => match.name).filter((name) => !boundSkills.has(name));
  // Every catalogued agent is an external one: a project is reachable as a
  // subagent, but only through a binding someone made, and its published
  // version is what decides whether it can run at all.
  const subagentList: SubagentRef[] = agents
    .filter((match) => !boundAgents.has(match.name))
    .map((match) => ({ name: match.name, type: "remote" as const }));

  const mcpList: McpBinding[] = [];
  const notes: string[] = [];
  const seenServers = new Set<string>();
  // Tool hits lead: they name a server *and* which of its tools to offer, which
  // is strictly more than a server hit says. A server reached both ways is
  // bound once, narrowed.
  for (const match of [...toolHits, ...serverHits]) {
    if (boundServers.has(match.name) || seenServers.has(match.name)) {
      continue;
    }
    if (mcpList.length >= DISCOVERY_LIMITS.mcpServer) {
      break;
    }
    seenServers.add(match.name);
    const server = await deps.mcps.get(match.name);
    if (!server) {
      continue;
    }
    if (server.auth) {
      notes.push(
        `MCP server '${match.name}' matched this request but needs an authorized connection; bind it to this version to use it.`,
      );
      continue;
    }
    // Narrowed to the tools that actually matched, which is what `McpBinding.tools`
    // is for: a discovered server should not spend the run's tool budget on the
    // rest of its catalogue. A server hit carries none — nothing knows what it
    // offers yet — so it is bound whole and the dispatch-time listing decides.
    const tools = toolHits
      .filter((entry) => entry.name === match.name && entry.toolName !== undefined)
      .map((entry) => entry.toolName as string);
    mcpList.push({ name: match.name, ...(tools.length > 0 ? { tools } : {}) });
  }
  return { skillList, subagentList, mcpList, notes };
}

/**
 * Resolve a version's skills, subagents and MCP tools together.
 *
 * The MCP promise is handled separately so a *sibling's* failure still releases
 * the sessions that opened: awaiting all three as a plain `Promise.all` drops
 * the tool manager on the floor, and every session it opened stays alive
 * server-side until that server times it out.
 *
 * When the version opted into discovery and this deployment has a catalog, the
 * search runs *first* and its results are appended to the version's own lists —
 * the resolution below then treats bound and discovered alike, which is what
 * keeps every later stage (the prompt tables, the tool enums, the reachability
 * checks) from needing to know the difference.
 */
export async function resolveRunTools(
  deps: Pick<ExecutionDeps, "externalAgents" | "projects" | "skills" | "catalog"> & McpToolDeps,
  version: Version,
  signal?: AbortSignal,
  queries?: readonly string[],
): Promise<{
  skills: engine.SkillInfo[];
  subagents: engine.SubagentInfo[];
  mcp: ResolvedMcp;
  /** Everything the run lost while resolving, in version-list order. */
  warnings: string[];
}> {
  const discoveryNotes: string[] = [];
  if (version.parameters.dynamicCapabilities && deps.catalog && queries && queries.length > 0) {
    try {
      const found = await discoverCapabilities({ catalog: deps.catalog, mcps: deps.mcps }, version, queries);
      version = {
        ...version,
        skillList: [...(version.skillList ?? []), ...found.skillList],
        subagentList: [...(version.subagentList ?? []), ...found.subagentList],
        mcpList: [...(version.mcpList ?? []), ...found.mcpList],
      };
      discoveryNotes.push(...found.notes);
      const added = found.skillList.length + found.subagentList.length + found.mcpList.length;
      if (added > 0) {
        discoveryNotes.push(
          `Found ${added} capabilit${added === 1 ? "y" : "ies"} for this request: ${[
            ...found.skillList,
            ...found.subagentList.map((ref) => ref.name),
            ...found.mcpList.map((binding) => binding.name),
          ].join(", ")}.`,
        );
      }
    } catch (error) {
      // A catalog that is unreachable, unindexed, or refusing embeddings must
      // not take the run with it: the version's own bindings are still exactly
      // what it asked for, and running with them is the behaviour discovery was
      // added on top of.
      log.warn("catalog", "capability discovery failed; running with bindings only", error);
      discoveryNotes.push("Capability discovery failed; only this version's own bindings were offered.");
    }
  }

  const mcpPending = buildMcpTools(deps, version, signal);
  // Claim the rejection now: a sibling that rejects first would otherwise let
  // this one surface as an unhandled rejection before the catch below runs.
  const mcpSettled = mcpPending.then(
    (mcp) => ({ mcp }),
    (error: unknown) => ({ error }),
  );
  try {
    const [skills, subagents, settled] = await Promise.all([
      resolveSkills(deps, version.skillList),
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
      // Discovery notes lead: what a run was *given* beyond its configuration is
      // read before what it lost, and both reach the reader the same way.
      warnings: [
        ...discoveryNotes,
        ...skills.warnings,
        ...subagents.warnings,
        ...settled.mcp.warnings,
      ],
    };
  } catch (error) {
    const settled = await mcpSettled;
    if ("mcp" in settled) {
      await closeMcp(settled.mcp.close);
    }
    throw error;
  }
}
