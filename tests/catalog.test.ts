/**
 * The catalog: what a reindex writes and removes, and how a search ranks.
 *
 * Both sides are exercised against fakes rather than the S3 Vectors adapter —
 * what is worth pinning here is the two decisions that are ours (which entries
 * exist, and which of them a query gets back), not that an AWS client sends what
 * we told it to.
 */

import { describe, expect, it, vi } from "vitest";
import {
  MAX_CONCURRENT_CATALOG_PROBES,
  reindexCatalog,
  type CatalogIndexDeps,
} from "@/application/catalog/reindexCatalog";
import { catalogDescription } from "@/domain/catalog/types";
import {
  CAPABILITY_RERANK_INSTRUCTION,
  searchCapabilities,
} from "@/application/catalog/searchCatalog";
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

describe("catalogDescription", () => {
  it("caps a description by character, never through one", () => {
    // The text is embedded, stored and offered to the model. Half a character
    // is not text on any of those three routes, and the description comes from
    // a plugin repository rather than from this app.
    const capped = catalogDescription(`x${"\uD83D\uDE00".repeat(1_000)}`);
    expect(capped.endsWith("…")).toBe(true);
    expect(capped.isWellFormed()).toBe(true);
  });

  it("measures the cap in the units it cuts, so nothing gains a … without losing text", () => {
    // 400 emoji: 800 UTF-16 units but only 401 code points — under the cap.
    const description = `x${"😀".repeat(400)}`;
    expect(catalogDescription(description)).toBe(description);
  });
});

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

  it("leaves alone a key another pass wrote while this one was running", async () => {
    // The hourly tick and the reindex a plugins sync fires overlap as a matter
    // of course. Reading the index at the end would let the tick — whose
    // snapshot predates the sync — delete the entries the sync had just added.
    const recorded = fakeStore(["skill#kept"]);
    let listed = false;
    const store: VectorStorePort = {
      ...recorded.store,
      async listKeys() {
        listed = true;
        return ["skill#kept"];
      },
    };
    await reindexCatalog(
      indexDeps({
        catalog: store,
        skills: {
          list: async () => {
            // Whatever a concurrent pass writes lands after this read, so it
            // cannot be a candidate for this one's prune.
            expect(listed).toBe(true);
            return [skill("kept")];
          },
        },
      }),
    );
    expect(recorded.deleted).toEqual([]);
  });

  it("refuses to empty the index when the registries came back empty", async () => {
    // Every registry empty at once is not a state this platform reaches; a
    // table name pointed elsewhere or a local process aimed at the deployed
    // index are, and they look identical from here.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const recorded = fakeStore(["skill#a", "skill#b"]);
      const report = await reindexCatalog(indexDeps({ catalog: recorded.store }));
      expect(recorded.deleted).toEqual([]);
      expect(report).toMatchObject({ indexed: 0, removed: 0 });
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("keeps indexing when one server's probe throws", async () => {
    // `testConnection` throws for a server deleted since `list()` or one whose
    // headers no longer decrypt. A bare `Promise.all` made either freeze the
    // whole index until someone fixed the one bad row.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const recorded = fakeStore();
      const report = await reindexCatalog(
        indexDeps({
          catalog: recorded.store,
          skills: { list: async () => [skill("kept")] },
          mcps: { list: async () => [server("gone", "Deleted"), server("ok", "Fine")] },
          probeMcpTools: async (name) => {
            if (name === "gone") {
              throw new Error("not found");
            }
            return [{ name: "search" }];
          },
        }),
      );
      expect(recorded.upserted.map((record) => record.key)).toEqual([
        "skill#kept",
        "mcpServer#gone",
        "mcpServer#ok",
        "mcpTool#ok#search",
      ]);
      expect(report.undiscovered).toEqual(["gone"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("bounds concurrent MCP probes while preserving every server", async () => {
    const servers = Array.from(
      { length: MAX_CONCURRENT_CATALOG_PROBES + 2 },
      (_, index) => server(`server-${index}`, "Server"),
    );
    let active = 0;
    let maxActive = 0;
    const recorded = fakeStore();

    const report = await reindexCatalog(
      indexDeps({
        catalog: recorded.store,
        mcps: { list: async () => servers },
        probeMcpTools: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await Promise.resolve();
          active -= 1;
          return [];
        },
      }),
    );

    expect(maxActive).toBe(MAX_CONCURRENT_CATALOG_PROBES);
    expect(report.indexed).toBe(servers.length);
    expect(recorded.upserted.map((record) => record.key)).toEqual(
      servers.map((entry) => `mcpServer#${entry.name}`),
    );
  });

  it("keeps an entry whose vector was missing rather than pruning it", async () => {
    // "Skip it" quietly meant "delete whatever it already had", because the
    // skipped key never entered the live set the prune is computed against.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const recorded = fakeStore(["skill#a", "skill#b"]);
      const report = await reindexCatalog(
        indexDeps({
          catalog: recorded.store,
          skills: { list: async () => [skill("a"), skill("b")] },
          // A shape nothing here can act on, for the second entry only.
          embeddings: { embed: async (texts) => texts.map((_, index) => (index === 1 ? [] : [1])) },
        }),
      );
      expect(recorded.upserted.map((record) => record.key)).toEqual(["skill#a"]);
      expect(recorded.deleted).toEqual([]);
      expect(report).toMatchObject({ indexed: 1, removed: 0 });
    } finally {
      warn.mockRestore();
    }
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

  it("reranks the vector candidates with the indexed capability text", async () => {
    const rerank = vi.fn(async () => [0.1, 0.9, 0.01]);
    const deps = {
      ...searchDeps([
        [
          match("skill#vector-first", 0.9, {
            name: "vector-first",
            description: "First description",
          }),
          match("skill#reranked-first", 0.8, {
            name: "reranked-first",
            description: "Second description",
          }),
          match("skill#reranker-rejected", 0.7, {
            name: "reranker-rejected",
            description: "Rejected description",
          }),
          match("skill#below-cut", 0.2, { name: "below-cut", description: "Not relevant" }),
        ],
      ]),
      reranker: { rerank },
    };
    const found = await searchCapabilities(deps, ["the request"], { kind: "skill", limit: 2 });
    expect(found.map((entry) => entry.name)).toEqual(["reranked-first", "vector-first"]);
    expect(rerank).toHaveBeenCalledWith(
      "the request",
      [
        "vector-first\nFirst description",
        "reranked-first\nSecond description",
        "reranker-rejected\nRejected description",
      ],
      CAPABILITY_RERANK_INSTRUCTION,
    );
  });

  it("keeps a low absolute reranker score when it clearly identifies an AWS capability", async () => {
    const rerank = vi.fn(async () => [0.03, 0.0003]);
    const found = await searchCapabilities(
      {
        ...searchDeps([
          [
            match("mcpServer#aws-knowledge", 0.62, {
              name: "aws-knowledge",
              description: "Search AWS documentation and API references",
            }),
            match("mcpServer#cloudwatch", 0.56, {
              name: "cloudwatch",
              description: "Query CloudWatch metrics and logs",
            }),
          ],
        ]),
        reranker: { rerank },
        rerankerMinScore: 0.01,
      },
      ["aws eks 최신 버전 알려줘"],
      { kind: "mcpServer", limit: 5 },
    );
    expect(found.map((entry) => entry.name)).toEqual(["aws-knowledge"]);
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

  it("boosts a name only where the query uses it as a word", async () => {
    // `git` inside "legitimate" is the shape this caught: one of the two
    // queries is a 2000-character system prompt, so a substring test boosted
    // short names on nearly every run — and the boost is applied before the
    // proportional cut, so it also raises what everything else is measured
    // against.
    const found = await searchCapabilities(
      searchDeps([
        [
          match("mcpServer#deploy", 0.9, { name: "deploy", description: "" }),
          match("mcpServer#git", 0.75, { name: "git", description: "" }),
        ],
      ]),
      ["this is a legitimate deploy request"],
      { kind: "mcpServer", limit: 5 },
    );
    expect(found[0]?.name).toBe("deploy");
  });

  it("still matches a name at the end of a sentence", async () => {
    const found = await searchCapabilities(
      searchDeps([
        [
          match("mcpServer#chat-relay", 0.9, { name: "chat-relay", description: "" }),
          match("mcpServer#slack", 0.75, { name: "slack", description: "" }),
        ],
      ]),
      ["please post this to slack."],
      { kind: "mcpServer", limit: 5 },
    );
    expect(found[0]?.name).toBe("slack");
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
