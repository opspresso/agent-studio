/** Resolving a version's skills, subagents and MCP tools for one run. */

import type { McpBinding, SubagentRef, Version } from "@/domain/project/types";
import { messageText } from "@/domain/llm/types";
import type { ChatMessageInput } from "@/domain/llm/types";
import type { RunOrigin } from "@/domain/execution/actor";
import type { Skill } from "@/domain/skill/types";
import { loadSkillFileContent } from "@/application/skill/loadSkill";
import { listProjectMcpConnections } from "@/application/mcp/listConnections";
import { searchCapabilitiesByKind, type CatalogSearchDeps } from "@/application/catalog/searchCatalog";
import * as engine from "@/application/llm/engine";
import type { ExecutionDeps } from "./deps";
import { buildMcpTools, closeMcp, type McpToolDeps, type ResolvedMcp } from "./mcpTools";
import { MAX_TRACED_DISCOVERED } from "@/application/trace/recorder";
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
const DISCOVERY_LIMITS = { skill: 5, agent: 3, mcpServer: 3 } as const;

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

/**
 * How many of the newest user turns search the catalog.
 *
 * The newest turn alone reads as the whole request only on a conversation's
 * first message. A follow-up — "review the first one" — names nothing the
 * catalog can match, while the turn before it named everything: the capability
 * the conversation was already using stopped being found exactly when the user
 * referred back to it, and the model retried a tool call its history replays
 * but the run no longer declares. A short window keeps those matches alive.
 * Each turn stays its own query — the search ranks and cuts per query, so an
 * older turn can only add candidates, never dilute the newest.
 */
const REQUEST_QUERY_TURNS = 3;

/**
 * The newest user turns as discovery request queries, oldest first.
 *
 * For the surface that holds a conversation; one with a single request passes
 * it directly. Text only, like the search itself — an image part says nothing
 * an embedding can rank.
 */
export function recentUserQueries(messages: readonly ChatMessageInput[]): string[] {
  const texts: string[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (texts.length >= REQUEST_QUERY_TURNS) {
      break;
    }
    const message = messages[index];
    if (message?.role === "user") {
      const text = messageText(message).trim();
      if (text) {
        texts.push(text);
      }
    }
  }
  return texts.reverse();
}

/**
 * The queries a run searches the catalog with, in the order they are ranked.
 *
 * Every query is bounded by the same slice as the prompt's: a user turn
 * carrying a pasted document would otherwise spend the embedding provider's
 * input limit on the least discriminating part, or fail the whole search
 * outright. Deduplicated because a repeated text adds embedding tokens and
 * vector-store queries for an answer the first copy already gives.
 */
export function discoveryQueries(version: Version, requests: readonly string[] = []): string[] {
  return [
    ...new Set(
      [
        version.systemPrompt.slice(0, PROMPT_QUERY_CHARS),
        ...requests.map((request) => request.slice(0, PROMPT_QUERY_CHARS)),
      ].filter((query) => query.trim() !== ""),
    ),
  ];
}

/**
 * Capabilities to offer beyond what the version bound.
 *
 * Everything here is *additive*: it returns names to append, and the caller
 * appends them after the bindings. A version's own list is never reordered,
 * filtered or truncated by this — which is the whole reason a project can turn
 * discovery on without auditing what it already relies on.
 *
 * **An MCP server that requires OAuth is added only where this project has
 * already connected it.** Someone authorizing a server in the console is
 * saying this project may use it, and there is no reason discovery should be
 * the one caller that ignores that. What it must not do is *resolve* the
 * credential to find out: `headersFor` refreshes tokens as a side effect, so
 * asking it a question would make discovery a writer. The connection rows
 * answer the same question by being read.
 *
 * A connection that has gone stale since — a revoked grant, a rotated client —
 * is not this function's problem: `buildMcpTools` resolves it for real at
 * dispatch and reports a server that cannot authenticate, exactly as it does
 * for one the version bound by hand.
 */
async function discoverCapabilities(
  deps: {
    catalog: CatalogSearchDeps;
    mcps: Pick<ExecutionDeps["mcps"], "get">;
    mcpConnections?: ExecutionDeps["mcpConnections"];
  },
  version: Version,
  queries: readonly string[],
): Promise<{ skillList: string[]; subagentList: SubagentRef[]; mcpList: McpBinding[]; notes: string[] }> {
  const boundSkills = new Set(version.skillList ?? []);
  const boundAgents = new Set((version.subagentList ?? []).map((ref) => ref.name));
  const boundServers = new Set((version.mcpList ?? []).map((binding) => binding.name));

  // One embedding pass for all four: the vector is the query, and only the
  // filter differs. Asking per kind meant four identical embeddings per run.
  const [skills = [], agents = [], toolHits = [], serverHits = []] =
    await searchCapabilitiesByKind(deps.catalog, queries, [
      { kind: "skill", limit: DISCOVERY_LIMITS.skill },
      { kind: "agent", limit: DISCOVERY_LIMITS.agent },
      // Tools are what a request matches, but a server is what a run can bind —
      // so the tool index answers "which server", and the binding is the server.
      { kind: "mcpTool", limit: DISCOVERY_LIMITS.mcpServer * 4 },
      // And the server index answers for everything the tool index cannot: a
      // server whose tools could not be listed when the catalog was built has no
      // tool rows at all, so searching tools alone makes it permanently
      // undiscoverable — which is most of the point of indexing servers
      // separately. Its listing may well succeed at dispatch (a credential fixed
      // since, a server that was down), and if it does not, the run reports it
      // like any other binding that came back empty.
      //
      // Oversampled past the binding cap, because a candidate the loop below
      // skips — an OAuth server this project has not connected, an entry
      // deleted since the index was built — must not cost a slot. Sized at
      // exactly the cap, one unconnected high scorer starved the servers the
      // request actually asked for.
      { kind: "mcpServer", limit: DISCOVERY_LIMITS.mcpServer * 3 },
    ]);

  const skillList = skills.map((match) => match.name).filter((name) => !boundSkills.has(name));
  // Every catalogued agent is an external one: a project is reachable as a
  // subagent, but only through a binding someone made, and its published
  // version is what decides whether it can run at all.
  const subagentList: SubagentRef[] = agents
    .filter((match) => !boundAgents.has(match.name))
    .map((match) => ({ name: match.name, type: "remote" as const }));

  // One read for the whole run, not one per candidate. `needs_auth` and
  // `needs_reauth` are connections in name only — the console shows both as
  // something a person still has to finish — so only `connected` counts.
  const connections = deps.mcpConnections
    ? await listProjectMcpConnections(deps.mcpConnections, version.projectName)
    : [];
  const connected = new Set<string>(
    connections
      .filter((connection) => connection.status === "connected")
      .map((connection) => connection.serverName),
  );

  // One candidate per server, scored by the best evidence from either index,
  // and walked in that order. "Tool hits lead" used to be *source* order —
  // every tool hit outranked every server hit — so a persona prompt's
  // incidental tool matches at 0.23 filled all three slots ahead of the
  // request's own servers at 0.33, which is how "클러스터 상태 어때?"
  // discovered a document store. What a tool hit knows that a server hit does
  // not — which tools matched — is kept as the binding's narrowing below, not
  // as a ranking privilege. The scores are comparable: one embedding space,
  // or one reranker when configured, and each kind was already cut against its
  // own best.
  const candidates = new Map<string, { score: number; tools: string[] }>();
  for (const match of toolHits) {
    const entry = candidates.get(match.name) ?? { score: 0, tools: [] };
    entry.score = Math.max(entry.score, match.score);
    if (match.toolName !== undefined) {
      entry.tools.push(match.toolName);
    }
    candidates.set(match.name, entry);
  }
  for (const match of serverHits) {
    const entry = candidates.get(match.name) ?? { score: 0, tools: [] };
    entry.score = Math.max(entry.score, match.score);
    candidates.set(match.name, entry);
  }
  // Ties break by name so equal evidence selects the same server every turn.
  const ranked = [...candidates.entries()]
    .map(([name, entry]) => ({ name, ...entry }))
    .sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const mcpList: McpBinding[] = [];
  const notes: string[] = [];
  for (const candidate of ranked) {
    if (mcpList.length >= DISCOVERY_LIMITS.mcpServer) {
      break;
    }
    if (boundServers.has(candidate.name)) {
      continue;
    }
    const server = await deps.mcps.get(candidate.name);
    if (!server) {
      continue;
    }
    if (server.auth && !connected.has(candidate.name)) {
      notes.push(
        `MCP server '${candidate.name}' matched this request but this project has not connected it; authorize it from that server's own settings — binding it alone would still leave the run unable to sign in.`,
      );
      continue;
    }
    // Narrowed to the tools that actually matched, which is what `McpBinding.tools`
    // is for: a discovered server should not spend the run's tool budget on the
    // rest of its catalogue. A candidate only the server index reached carries
    // none — nothing knows what it offers yet — so it is bound whole and the
    // dispatch-time listing decides.
    mcpList.push({
      name: candidate.name,
      ...(candidate.tools.length > 0 ? { tools: candidate.tools } : {}),
    });
  }
  // Name order, not score order. Order carries no meaning downstream — the
  // prompt tables do not rank, and the bindings always lead — but it decides
  // two things that must not flap between turns of one conversation: which
  // colliding MCP tool keeps its bare name (alias allocation walks the servers
  // in list order, so a swap re-routes a tool call the history replays), and
  // the byte layout of the system prompt, which the provider's prompt cache
  // keys on. Scores rank differently for every message; names do not.
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  skillList.sort();
  subagentList.sort(byName);
  mcpList.sort(byName);
  return { skillList, subagentList, mcpList, notes };
}

/**
 * What the tools stage reports on its trace span.
 *
 * One owner because two run levels record it — the top-level run and an agent
 * child — and a field added to one copy is a field the other silently stops
 * carrying. The counts answer what a slow or thin resolve raises: was it slow,
 * and did it come back with what the version declares. Discovery's additions
 * are **named** rather than counted, because they are the one part of a run's
 * plan that changes per request; bounded like every other accumulator on a
 * trace, with the count beside the list saying how many were found in all (so a
 * list of twenty beside a count of twenty-five means five are not shown).
 */
export function toolsPrepared(resolved: {
  skills: readonly unknown[];
  subagents: readonly unknown[];
  mcp: { mcpServers: readonly unknown[]; mcpTools: readonly unknown[] };
  discovered: readonly string[];
  warnings: readonly string[];
}): Record<string, unknown> {
  return {
    skills: resolved.skills.length,
    subagents: resolved.subagents.length,
    mcpServers: resolved.mcp.mcpServers.length,
    mcpTools: resolved.mcp.mcpTools.length,
    ...(resolved.discovered.length > 0
      ? {
          discovered: resolved.discovered.length,
          discoveredNames: resolved.discovered.slice(0, MAX_TRACED_DISCOVERED),
        }
      : {}),
    ...(resolved.warnings.length > 0 ? { warnings: resolved.warnings.length } : {}),
  };
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
  deps: Pick<ExecutionDeps, "externalAgents" | "projects" | "skills" | "catalog" | "mcpConnections"> & McpToolDeps,
  version: Version,
  signal?: AbortSignal,
  queries?: readonly string[],
  /**
   * Where the run came from. MCP resolution names an email actor and the
   * conversation to every server as request headers.
   */
  origin?: Pick<RunOrigin, "actor" | "userEmail" | "conversation">,
): Promise<{
  skills: engine.SkillInfo[];
  subagents: engine.SubagentInfo[];
  mcp: ResolvedMcp;
  /** Everything the run lost while resolving, in version-list order. */
  warnings: string[];
  /**
   * What a search added beyond the version's own bindings — a **gain**, which is
   * why it is not in `warnings`.
   *
   * It was, and every healthy run of a discovery-enabled version therefore
   * reported a warning: a yellow alert on every chat turn, a non-empty
   * `warnings` array in every `/predict` answer, and anything keying on "did
   * this run report a loss" firing on all of them. `collectedWarning` owns what
   * a run *lost*, and a capability being found is the opposite of that. The
   * preview renders this on its own; a run logs it, since what a run actually
   * used is already visible in its tool traffic.
   */
  discovered: string[];
  /**
   * The version as this resolve read it — the caller's own where nothing was
   * discovered, and widened by the search where something was.
   *
   * Returned because **the resolved lists are not the whole story**. `subagents`
   * above is what the model is *told* about, while what it can actually reach is
   * decided separately by `buildSubagentRunner`, from a `subagentList`. Handing
   * the caller the widened version is what keeps those two reading the same
   * list: passing the original meant a discovered agent appeared in the transfer
   * enum and the prompt's table, and answered `Unknown agent` when the model
   * used it.
   */
  version: Version;
}> {
  const discoveryNotes: string[] = [];
  const discovered: string[] = [];
  // A version that asked for discovery and did not get it says so, on the same
  // channel a failed search uses. Nothing else can tell the author: the checkbox
  // stays ticked, the bindings still resolve, the run answers normally, and the
  // preview shows the same prompt — the feature reads as on and is inert. That
  // is the shape of the defect this branch was itself found to have, one call
  // site up, so it is not left to be discovered the same way twice.
  if (version.parameters.dynamicCapabilities) {
    if (!deps.catalog) {
      discoveryNotes.push(
        "This version is set to find capabilities for each request, but this deployment has no capability catalog; only its own bindings were offered.",
      );
    } else if (!queries || queries.length === 0) {
      discoveryNotes.push(
        "This version is set to find capabilities for each request, but there was nothing to search with — no system prompt and no request text; only its own bindings were offered.",
      );
    } else {
      try {
        const found = await discoverCapabilities(
          {
            catalog: deps.catalog,
            mcps: deps.mcps,
            ...(deps.mcpConnections ? { mcpConnections: deps.mcpConnections } : {}),
          },
          version,
          queries,
        );
        version = {
          ...version,
          skillList: [...(version.skillList ?? []), ...found.skillList],
          subagentList: [...(version.subagentList ?? []), ...found.subagentList],
          mcpList: [...(version.mcpList ?? []), ...found.mcpList],
        };
        discoveryNotes.push(...found.notes);
        discovered.push(
          ...found.skillList,
          ...found.subagentList.map((ref) => ref.name),
          ...found.mcpList.map((binding) => binding.name),
        );
      } catch (error) {
        // A catalog that is unreachable, unindexed, or refusing embeddings must
        // not take the run with it: the version's own bindings are still exactly
        // what it asked for, and running with them is the behaviour discovery was
        // added on top of.
        log.warn("catalog", "capability discovery failed; running with bindings only", error);
        discoveryNotes.push(
          "Capability discovery failed; only this version's own bindings were offered.",
        );
      }
    }
  }

  const mcpPending = buildMcpTools(deps, version, signal, origin);
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
      version,
      discovered,
      // Discovery's losses lead — a search that could not run, or a server it
      // matched but the project cannot sign in to, is context for every binding
      // warning after it. What a search *found* is not here; see `discovered`.
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
