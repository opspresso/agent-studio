/**
 * Rebuilding the global capability index from the registries.
 *
 * Driven by a periodic tick rather than hooked into every registry write. A
 * write hook would have to decide what a successful save with a failed
 * indexing means — and the honest answer is "nothing an operator should see a
 * 500 for", since the catalog only affects which capabilities a run *discovers*
 * and never what a version explicitly bound. Freshness in seconds buys nothing
 * here; a tick that runs and reports is worth more than a write path that can
 * fail in a new way.
 *
 * The whole index is rewritten each time, which is also what removes entries the
 * registries no longer have: keys are derived from the entry, so what is in the
 * index and not in this run's key set is exactly what is gone.
 */

import type { CapabilityEntry } from "@/domain/catalog/types";
import { capabilityKey, capabilityText, catalogDescription } from "@/domain/catalog/types";
import type { McpTool } from "@/domain/mcp/types";
import type { McpRepository } from "@/domain/mcp/repository";
import type { SkillRepository } from "@/domain/skill/repository";
import type { ExternalAgentRepository } from "@/domain/agent/repository";
import type { EmbeddingPort, VectorRecord, VectorStorePort } from "@/domain/vector/types";
import { log } from "@/shared/logger";
import { listRegistry } from "@/application/registry/registryUseCases";

/**
 * Discovering one server's tools, or `undefined` when it could not be reached.
 *
 * A function rather than the MCP use cases themselves: what the catalog needs is
 * one answer per server, and the probe that gives it already exists behind the
 * console's "test connection".
 */
export type ProbeMcpTools = (serverName: string) => Promise<readonly McpTool[] | undefined>;

export interface CatalogIndexDeps {
  skills: Pick<SkillRepository, "list">;
  mcps: Pick<McpRepository, "list">;
  externalAgents: Pick<ExternalAgentRepository, "list">;
  probeMcpTools: ProbeMcpTools;
  embeddings: EmbeddingPort;
  catalog: VectorStorePort;
}

export interface ReindexReport {
  indexed: number;
  removed: number;
  /**
   * Servers whose tools could not be listed, which are indexed at server level
   * only. Reported rather than logged and forgotten: an OAuth server nobody has
   * connected looks exactly like a broken one from here, and the difference
   * matters to whoever reads why a search never surfaces its tools.
   */
  undiscovered: string[];
}

/** Everything the registries currently hold, as entries. */
async function collectEntries(
  deps: CatalogIndexDeps,
): Promise<{ entries: CapabilityEntry[]; undiscovered: string[] }> {
  const [skills, servers, agents] = await Promise.all([
    listRegistry(deps.skills),
    listRegistry(deps.mcps),
    listRegistry(deps.externalAgents),
  ]);
  const entries: CapabilityEntry[] = [];
  for (const skill of skills) {
    entries.push({ kind: "skill", name: skill.name, description: skill.description });
  }
  for (const agent of agents) {
    entries.push({ kind: "agent", name: agent.name, description: agent.description });
  }

  // Probed in parallel: each is a round trip to someone else's server, and a
  // reindex walks every one of them.
  //
  // Fenced per server, the way the plugins sync fences a write. `probeMcpTools`
  // is `testConnection`, which *throws* rather than answering for a server
  // deleted since `list()` or one whose stored headers no longer decrypt under
  // the current key — and a bare `Promise.all` turned either into a rejected
  // rebuild that wrote nothing at all, freezing the whole index until someone
  // fixed the one bad row. A server that cannot be probed is the case
  // `undiscovered` already exists for.
  const undiscovered: string[] = [];
  const probed = await Promise.all(
    servers.map(async (server) => ({
      server,
      tools: await deps.probeMcpTools(server.name).catch((error: unknown) => {
        log.warn("catalog", `probing '${server.name}' failed; indexing it without its tools`, error);
        return undefined;
      }),
    })),
  );
  for (const { server, tools } of probed) {
    // Always present, whether or not its tools could be listed: this is the
    // entry a version binds, and a server that needs OAuth still has to be
    // findable by whoever would connect it.
    entries.push({ kind: "mcpServer", name: server.name, description: server.description ?? "" });
    if (!tools) {
      undiscovered.push(server.name);
      continue;
    }
    for (const tool of tools) {
      entries.push({
        kind: "mcpTool",
        name: server.name,
        toolName: tool.name,
        description: tool.description ?? "",
      });
    }
  }
  return { entries, undiscovered };
}

export async function reindexCatalog(deps: CatalogIndexDeps): Promise<ReindexReport> {
  // Read *before* the registries, and it is the ordering that matters rather
  // than the cost. Pruning means "keys this pass did not write", and taking that
  // list at the end makes it "keys written by anyone else since I started" too:
  // the hourly tick and the reindex a plugins sync fires now overlap as a matter
  // of course, and the tick — whose snapshot predates the sync — would delete
  // the very entries the sync had just added, leaving them undiscoverable until
  // the next hour. Taken first, a key another pass wrote after this one began is
  // simply not a candidate, and a genuinely stale one is caught on the pass
  // after. No lock, and nothing to hold across a rebuild.
  const keysAtStart = await deps.catalog.listKeys();
  const { entries, undiscovered } = await collectEntries(deps);
  // Documents: these are the things a query will be matched *against*.
  const vectors = await deps.embeddings.embed(entries.map(capabilityText), "document");
  const records: VectorRecord[] = [];
  const keep = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const key = capabilityKey(entry);
    keep.add(key);
    const vector = vectors[index];
    if (!vector || vector.length === 0) {
      // A short answer or a zero-length vector. The adapters refuse a count
      // mismatch, so reaching this means a shape nothing here can act on — and
      // an empty vector is not the harmless case it looks like: the index fixes
      // its dimension, so writing one fails the whole batch it rides in.
      //
      // It is still a live capability, so its key is kept out of the prune
      // above; otherwise "skip it" quietly meant "delete whatever it already
      // had", which is the opposite of leaving the index alone.
      log.warn("catalog", `no usable vector for ${key}; leaving its existing entry alone`);
      continue;
    }
    records.push({
      key,
      vector,
      metadata: {
        kind: entry.kind,
        name: entry.name,
        ...(entry.toolName !== undefined ? { toolName: entry.toolName } : {}),
        description: catalogDescription(entry.description),
      },
    });
  }
  await deps.catalog.upsert(records);

  // After the upsert, never before: a crash between the two leaves the index
  // holding entries that no longer exist, which the next tick removes. The other
  // order would leave a window where a live capability is absent from the index
  // entirely, and searches during it would silently under-answer.
  const stale = keysAtStart.filter((key) => !keep.has(key));
  // Nothing collected is a claim about the registries, and "every registry is
  // empty at once" is not a state this platform reaches — a table name pointed
  // somewhere else, a role that lost its reads, a local process aimed at the
  // deployed index are. Each of those looks identical from here and would erase
  // the catalog in one call, so the total wipe is the one prune refused. Said
  // out loud rather than skipped quietly: an operator who *did* empty the
  // registries deliberately needs to know why the index still answers.
  if (entries.length === 0 && stale.length > 0) {
    log.error(
      "catalog",
      `the registries came back empty; refusing to delete all ${stale.length} indexed entries`,
    );
    return { indexed: 0, removed: 0, undiscovered };
  }
  if (stale.length > 0) {
    await deps.catalog.deleteByKeys(stale);
  }
  return { indexed: records.length, removed: stale.length, undiscovered };
}
