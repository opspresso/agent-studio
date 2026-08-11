/**
 * The catalog: what a reindex writes and removes, and how a search ranks.
 *
 * Both sides are exercised against fakes rather than the S3 Vectors adapter —
 * what is worth pinning here is the two decisions that are ours (which entries
 * exist, and which of them a query gets back), not that an AWS client sends what
 * we told it to.
 */

import { describe, expect, it, vi } from "vitest";
import { reindexCatalog, type CatalogIndexDeps } from "@/application/catalog/reindexCatalog";
import { searchCapabilities } from "@/application/catalog/searchCatalog";
import type { McpServer } from "@/domain/mcp/types";
import type { Skill } from "@/domain/skill/types";
import type { VectorMatch, VectorRecord, VectorStorePort } from "@/domain/vector/types";

interface Recording {
  store: VectorStorePort;
  upserted: VectorRecord[];
  deleted: string[];
  /** Which write happened first — the reindex's ordering is a contract. */
  order: string[];
}

function fakeStore(existingKeys: string[] = []): Recording {
  const upserted: VectorRecord[] = [];
  const deleted: string[] = [];
  const order: string[] = [];
  return {
    upserted,
    deleted,
    order,
    store: {
      async upsert(records) {
        order.push("upsert");
        upserted.push(...records);
      },
      async query() {
        return [];
      },
      async deleteByKeys(keys) {
        order.push("delete");
        deleted.push(...keys);
      },
      async listKeys() {
        return existingKeys;
      },
    },
  };
}

/** One dimension per text, so a vector is traceable back to its input order. */
const countingEmbeddings = {
  embed: async (texts: readonly string[]) => texts.map((_, index) => [index]),
};

const TIME = "2026-01-01T00:00:00Z";

function skill(name: string, description = "does a thing"): Skill {
  return { name, description, content: "", createdAt: TIME, updatedAt: TIME };
}

function server(name: string, description: string): McpServer {
  return { name, url: "https://example.test/mcp", description, headers: {}, createdAt: TIME, updatedAt: TIME };
}

function indexDeps(overrides: Partial<CatalogIndexDeps> = {}): CatalogIndexDeps {
  return {
    skills: { list: async () => [] },
    mcps: { list: async () => [] },
    externalAgents: { list: async () => [] },
    probeMcpTools: async () => [],
    embeddings: countingEmbeddings,
    catalog: fakeStore().store,
    ...overrides,
  };
}

describe("reindexCatalog", () => {
  it("indexes a server and each of its tools, keyed so a rerun is an upsert", async () => {
    const recorded = fakeStore();
    const report = await reindexCatalog(
      indexDeps({
        catalog: recorded.store,
        mcps: { list: async () => [server("github", "GitHub")] },
        probeMcpTools: async () => [
          { name: "create_pr", description: "Open a pull request" },
          { name: "add_comment" },
        ],
      }),
    );
    expect(recorded.upserted.map((record) => record.key)).toEqual([
      "mcpServer#github",
      "mcpTool#github#create_pr",
      "mcpTool#github#add_comment",
    ]);
    expect(report).toMatchObject({ indexed: 3, removed: 0, undiscovered: [] });
  });

  it("still indexes a server whose tools could not be listed, and says so", async () => {
    // An OAuth server nobody has connected refuses discovery. It is exactly the
    // entry someone needs to find in order to connect it.
    const recorded = fakeStore();
    const report = await reindexCatalog(
      indexDeps({
        catalog: recorded.store,
        mcps: { list: async () => [server("slack", "Slack")] },
        probeMcpTools: async () => undefined,
      }),
    );
    expect(recorded.upserted.map((record) => record.key)).toEqual(["mcpServer#slack"]);
    expect(report.undiscovered).toEqual(["slack"]);
  });

  it("removes what the registries no longer have, after writing what they do", async () => {
    // The order is the contract: upsert first means a crash between the two
    // leaves stale entries the next tick clears, rather than a window where a
    // live capability is missing from the index and searches under-answer.
    const recorded = fakeStore(["skill#kept", "skill#deleted-last-week"]);
    const report = await reindexCatalog(
      indexDeps({ catalog: recorded.store, skills: { list: async () => [skill("kept")] } }),
    );
    expect(recorded.deleted).toEqual(["skill#deleted-last-week"]);
    expect(recorded.order).toEqual(["upsert", "delete"]);
    expect(report.removed).toBe(1);
  });

  it("does not call delete when nothing is stale", async () => {
    const recorded = fakeStore(["skill#kept"]);
    await reindexCatalog(
      indexDeps({ catalog: recorded.store, skills: { list: async () => [skill("kept")] } }),
    );
    expect(recorded.order).toEqual(["upsert"]);
  });
});

function searchDeps(matches: VectorMatch[][]): Parameters<typeof searchCapabilities>[0] {
  let call = 0;
  return {
    embeddings: { embed: async (texts: readonly string[]) => texts.map(() => [1]) },
    catalog: {
      upsert: async () => {},
      deleteByKeys: async () => {},
      listKeys: async () => [],
      query: async () => matches[call++] ?? [],
    },
  };
}

const match = (key: string, score: number, metadata: Record<string, unknown>): VectorMatch => ({
  key,
  score,
  metadata,
});

describe("searchCapabilities", () => {
  it("lifts an entry the query names above one that merely reads like it", async () => {
    // The gap an embedding cannot close: "slack" names a thing exactly, and a
    // description that talks around it must not outrank it.
    const found = await searchCapabilities(
      searchDeps([
        [
          match("mcpServer#chat-relay", 0.9, { name: "chat-relay", description: "Send team messages" }),
          match("mcpServer#slack", 0.75, { name: "slack", description: "Workspace API" }),
        ],
      ]),
      ["post this to slack"],
      { kind: "mcpServer", limit: 5 },
    );
    expect(found.map((entry) => entry.name)).toEqual(["slack", "chat-relay"]);
  });

  it("keeps an entry's best score across queries rather than summing them", async () => {
    // Summing would rank an entry both queries reach weakly above one either
    // reaches strongly — breadth over fit.
    const found = await searchCapabilities(
      searchDeps([
        [match("skill#broad", 0.7, { name: "broad", description: "x" })],
        [
          match("skill#broad", 0.7, { name: "broad", description: "x" }),
          match("skill#sharp", 0.9, { name: "sharp", description: "y" }),
        ],
      ]),
      ["role description", "the actual request"],
      { kind: "skill", limit: 5 },
    );
    expect(found.map((entry) => entry.name)).toEqual(["sharp", "broad"]);
    expect(found[0]?.score).toBeCloseTo(0.9);
  });

  it("cuts by a fraction of the best score, not an absolute threshold", async () => {
    // Absolute cosine thresholds do not transfer between embedding models —
    // `mcp-memory` hit this and wrote it down. A ratio survives the swap. Here
    // every candidate clears the absolute floor, so the ratio is what decides:
    // `c` is an also-ran next to `a`, and only the shape of the set says so.
    const found = await searchCapabilities(
      searchDeps([
        [
          match("skill#a", 0.8, { name: "a", description: "" }),
          match("skill#b", 0.6, { name: "b", description: "" }),
          match("skill#c", 0.3, { name: "c", description: "" }),
        ],
      ]),
      ["anything"],
      { kind: "skill", limit: 10 },
    );
    expect(found.map((entry) => entry.name)).toEqual(["a", "b"]);
  });

  it("returns nothing when the whole field scores badly", async () => {
    // The case a ratio cannot see: half of the best bad score is still a bad
    // score, so a ratio alone answers a request the catalog has nothing for
    // with five irrelevant rows. Measured against Titan v2, this is exactly
    // where an unrelated query lands.
    const found = await searchCapabilities(
      searchDeps([
        [
          match("skill#a", 0.117, { name: "a", description: "" }),
          match("skill#b", 0.094, { name: "b", description: "" }),
          match("skill#c", 0.07, { name: "c", description: "" }),
        ],
      ]),
      ["calculate the eigenvalues of a matrix"],
      { kind: "skill", limit: 10 },
    );
    expect(found).toEqual([]);
  });

  it("honours an injected floor, since it belongs to the embedding model", async () => {
    const deps = { ...searchDeps([[match("skill#a", 0.2, { name: "a", description: "" })]]), minScore: 0.5 };
    expect(await searchCapabilities(deps, ["q"], { kind: "skill", limit: 5 })).toEqual([]);
  });

  it("matches a hyphenated name written as separate words", async () => {
    const found = await searchCapabilities(
      searchDeps([
        [
          match("skill#other", 0.9, { name: "other", description: "" }),
          match("skill#code-review", 0.7, { name: "code-review", description: "" }),
        ],
      ]),
      ["please do a code review"],
      { kind: "skill", limit: 5 },
    );
    expect(found[0]?.name).toBe("code-review");
  });

  it("does not embed or query when every query is blank", async () => {
    const embed = vi.fn();
    const found = await searchCapabilities(
      { embeddings: { embed }, catalog: searchDeps([]).catalog },
      ["", "   "],
      { kind: "skill", limit: 5 },
    );
    expect(found).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
  });
});
