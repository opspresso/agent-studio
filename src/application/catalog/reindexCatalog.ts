/**
 * Rebuild the global capability index from the current registries.
 * Callers own the installation-wide lease and search generation. Ordinary
 * registry writes do not reindex; ticks, model changes and completed plugin
 * syncs invoke this operation. Upsert precedes pruning so a failed rebuild
 * does not remove live entries before their replacements are stored.
 */

import type { CapabilityEntry } from "@/domain/catalog/types";
import { capabilityKey, capabilityText, catalogDescription } from "@/domain/catalog/types";
import type { McpTool } from "@/domain/mcp/types";
import type { McpRepository } from "@/domain/mcp/repository";
import type { SkillRepository } from "@/domain/skill/repository";
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

/** Remote MCP discovery calls allowed in flight during one rebuild. */
export const MAX_CONCURRENT_CATALOG_PROBES = 8;

/** Everything the registries currently hold, as entries. */
async function collectEntries(
  deps: CatalogIndexDeps,
): Promise<{ entries: CapabilityEntry[]; undiscovered: string[] }> {
  const [skills, servers] = await Promise.all([
    listRegistry(deps.skills),
    listRegistry(deps.mcps),
  ]);
  const entries: CapabilityEntry[] = [];
  for (const skill of skills) {
    entries.push({ kind: "skill", name: skill.name, description: skill.description });
  }

  // Bound outbound discovery and isolate each server's failure. An unreachable,
  // deleted or undecryptable server is still indexed without tools and reported
  // as undiscovered; it does not prevent indexing the remaining registry.
  const undiscovered: string[] = [];
  const probed: Array<{ server: (typeof servers)[number]; tools: readonly McpTool[] | undefined }> =
    new Array(servers.length);
  let nextServer = 0;
  async function probeNext(): Promise<void> {
    for (;;) {
      const index = nextServer++;
      const server = servers[index];
      if (!server) {
        return;
      }
      probed[index] = {
        server,
        tools: await deps.probeMcpTools(server.name).catch((error: unknown) => {
          log.warn(
            "catalog",
            `probing '${server.name}' failed; indexing it without its tools`,
            error,
          );
          return undefined;
        }),
      };
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENT_CATALOG_PROBES, servers.length) },
      () => probeNext(),
    ),
  );
  for (const { server, tools } of probed) {
    // Always present, whether or not its tools could be listed: this is the
    // entry an Agent binds, and a server that needs OAuth still has to be
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
  // Only keys present before this pass are prune candidates. Callers serialize
  // rebuilds with a lease; this snapshot also avoids deleting keys added later
  // if a rebuild outlives that lease.
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
      // Preserve the existing entry when this live capability has no usable
      // replacement vector. Empty vectors cannot be stored in the fixed dimension.
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

  // A failure before pruning leaves stale entries for the next successful pass.
  const stale = keysAtStart.filter((key) => !keep.has(key));
  if (stale.length > 0) {
    await deps.catalog.deleteByKeys(stale);
  }
  return { indexed: records.length, removed: stale.length, undiscovered };
}
