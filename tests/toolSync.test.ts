import { describe, expect, it } from "vitest";
import { parseToolDoc, syncToolsFromSnapshot } from "@/application/mcp/syncTools";
import type {
  CreateMcpInput,
  McpUseCases,
  UpdateMcpInput,
} from "@/application/mcp/mcpUseCases";
import type { ToolsRepoSnapshot } from "@/domain/mcp/toolsRepo";
import type { McpServer } from "@/domain/mcp/types";
import { ConflictError, ValidationError } from "@/application/errors";

const NOW = "2026-01-01T00:00:00.000Z";

/**
 * A registry that records what it was asked to create and to patch. Either may
 * be told to throw for a given name, which is how the guard's refusals are
 * exercised without wiring an SSRF policy through this test.
 *
 * `update` mirrors the real use case where it matters here: an absent field
 * leaves the stored one alone, and moving the address drops the OAuth block that
 * described the old one.
 */
function fakeMcps(existing: McpServer[] = [], refuse: Record<string, Error> = {}) {
  const store = new Map(existing.map((server) => [server.name, server]));
  const created: CreateMcpInput[] = [];
  const patched: Array<{ name: string; patch: UpdateMcpInput }> = [];
  const removed: string[] = [];
  const mcps: Pick<McpUseCases, "list" | "create" | "update" | "remove"> = {
    async list() {
      return [...store.values()];
    },
    async create(input) {
      const failure = refuse[input.name];
      if (failure) {
        throw failure;
      }
      created.push(input);
      const server: McpServer = {
        name: input.name,
        url: input.url,
        description: input.description,
        content: input.content,
        source: input.source,
        headers: {},
        createdAt: NOW,
        updatedAt: NOW,
      };
      store.set(server.name, server);
      return server;
    },
    async remove(name) {
      removed.push(name);
      store.delete(name);
    },
    async update(name, patch) {
      const failure = refuse[name];
      if (failure) {
        throw failure;
      }
      patched.push({ name, patch });
      const current = store.get(name)!;
      const moved = patch.url !== undefined && patch.url !== current.url;
      const { auth: discarded, ...withoutAuth } = current;
      void discarded;
      const next: McpServer = {
        ...(moved ? withoutAuth : current),
        url: patch.url ?? current.url,
        description: patch.description ?? current.description,
        content: patch.content ?? current.content,
        updatedAt: NOW,
      };
      store.set(name, next);
      return next;
    },
  };
  return { mcps, created, patched, removed, store };
}

function snapshot(files: Array<{ name: string; content: string }>, skippedPaths: string[] = []): ToolsRepoSnapshot {
  return {
    repo: "opspresso/agent-tools",
    branch: "main",
    commitSha: "abc123",
    files: files.map((file) => ({ ...file, path: `tools/${file.name}/TOOL.md` })),
    skippedPaths,
  };
}

const FETCHER = [
  "---",
  "name: mcp-url-fetch",
  "description: Fetches pages",
  "url: http://mcp-url-fetch.agent-mcps.svc.cluster.local:8080/mcp",
  "---",
  "",
  "# mcp-url-fetch",
  "",
  "Operator notes.",
].join("\n");

describe("parseToolDoc", () => {
  it("reads the url and description from frontmatter and keeps the body as notes", () => {
    expect(parseToolDoc(FETCHER)).toEqual({
      description: "Fetches pages",
      url: "http://mcp-url-fetch.agent-mcps.svc.cluster.local:8080/mcp",
      content: "# mcp-url-fetch\n\nOperator notes.",
    });
  });

  it("falls back to the first heading when no description is declared", () => {
    const doc = "---\nurl: https://x.test/mcp\n---\n# Memory server\nnotes";
    expect(parseToolDoc(doc).description).toBe("Memory server");
  });

  it("treats a blank url as absent", () => {
    expect(parseToolDoc("---\nurl:   \n---\nbody").url).toBeUndefined();
  });
});

describe("syncToolsFromSnapshot", () => {
  const REGISTERED: McpServer = {
    name: "mcp-url-fetch",
    url: "https://stale.example.com/mcp",
    description: "Edited in the console",
    content: "console notes",
    source: "github:opspresso/agent-tools",
    headers: { Authorization: "enc:v1:ciphertext" },
    auth: {
      type: "oauth2",
      resource: "https://stale.example.com",
      authorizationServer: "https://as.example.com",
      authorizationEndpoint: "https://as.example.com/authorize",
      tokenEndpoint: "https://as.example.com/token",
      tokenEndpointAuthMethod: "none",
      discoveredAt: NOW,
    },
    createdAt: NOW,
    updatedAt: NOW,
  };

  it("imports a tool the registry does not have", async () => {
    const { mcps, created } = fakeMcps();
    const result = await syncToolsFromSnapshot(mcps, snapshot([{ name: "mcp-url-fetch", content: FETCHER }]));

    expect(result.created).toEqual(["mcp-url-fetch"]);
    expect(created[0]).toMatchObject({
      name: "mcp-url-fetch",
      url: "http://mcp-url-fetch.agent-mcps.svc.cluster.local:8080/mcp",
      description: "Fetches pages",
      source: "github:opspresso/agent-tools",
      // A secret does not belong in git.
      headers: {},
    });
  });

  it("reports what an existing entry differs by, and writes nothing", async () => {
    const { mcps, patched, store } = fakeMcps([structuredClone(REGISTERED)]);

    const result = await syncToolsFromSnapshot(mcps, snapshot([{ name: "mcp-url-fetch", content: FETCHER }]));

    expect(result.existing).toEqual([
      { name: "mcp-url-fetch", differs: ["url", "description", "content"] },
    ]);
    // The stored version may be a correction someone made on purpose, and this
    // cannot tell that apart from a document that moved on.
    expect(patched).toEqual([]);
    expect(store.get("mcp-url-fetch")).toEqual(REGISTERED);
  });

  it("overwrites only the entry the caller named", async () => {
    const { mcps, store } = fakeMcps([structuredClone(REGISTERED)]);

    const result = await syncToolsFromSnapshot(
      mcps,
      snapshot([{ name: "mcp-url-fetch", content: FETCHER }]),
      { overwrite: ["mcp-url-fetch"] },
    );

    expect(result.overwritten).toEqual(["mcp-url-fetch"]);
    const after = store.get("mcp-url-fetch")!;
    expect(after.url).toBe("http://mcp-url-fetch.agent-mcps.svc.cluster.local:8080/mcp");
    expect(after.description).toBe("Fetches pages");
    // What git cannot hold is untouched.
    expect(after.headers).toEqual({ Authorization: "enc:v1:ciphertext" });
  });

  it("reports an entry that already agrees, without writing", async () => {
    const { mcps, patched } = fakeMcps([
      {
        name: "mcp-url-fetch",
        url: "http://mcp-url-fetch.agent-mcps.svc.cluster.local:8080/mcp",
        description: "Fetches pages",
        content: "# mcp-url-fetch\n\nOperator notes.",
        headers: {},
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);

    const result = await syncToolsFromSnapshot(
      mcps,
      snapshot([{ name: "mcp-url-fetch", content: FETCHER }]),
      { overwrite: ["mcp-url-fetch"] },
    );

    expect(result.existing).toEqual([{ name: "mcp-url-fetch", differs: [] }]);
    // An `updatedAt` that moved on every sync would make the registry look edited.
    expect(patched).toEqual([]);
  });

  it("keeps a field the document does not carry", async () => {
    const doc = ["---", "description: Fetches pages", "url: https://a.example.com/mcp", "---", ""].join("\n");
    const { mcps, store } = fakeMcps([
      {
        name: "mcp-url-fetch",
        url: "https://a.example.com/mcp",
        description: "old",
        content: "notes worth keeping",
        headers: {},
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);

    const result = await syncToolsFromSnapshot(mcps, snapshot([{ name: "mcp-url-fetch", content: doc }]), {
      overwrite: ["mcp-url-fetch"],
    });

    // An empty body says nothing about the notes; it does not ask for them to
    // be erased.
    expect(result.overwritten).toEqual(["mcp-url-fetch"]);
    expect(store.get("mcp-url-fetch")?.content).toBe("notes worth keeping");
    expect(store.get("mcp-url-fetch")?.description).toBe("Fetches pages");
  });

  it("will not let the repository move a managed entry's address, and says so", async () => {
    const { mcps, store } = fakeMcps([
      {
        name: "mcp-url-fetch",
        runtime: "managed",
        url: "http://127.0.0.1:41234/mcp",
        description: "stale",
        content: "",
        headers: {},
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);

    const result = await syncToolsFromSnapshot(mcps, snapshot([{ name: "mcp-url-fetch", content: FETCHER }]), {
      overwrite: ["mcp-url-fetch"],
    });

    expect(result.skipped).toEqual([
      { name: "mcp-url-fetch", reason: "managed-url", detail: "http://127.0.0.1:41234/mcp" },
    ]);
    // Its address is the basis for trusting it; the rest still applied.
    expect(store.get("mcp-url-fetch")?.url).toBe("http://127.0.0.1:41234/mcp");
    expect(store.get("mcp-url-fetch")?.description).toBe("Fetches pages");
  });

  it("reports an entry this sync created that the repo no longer carries", async () => {
    const { mcps, removed } = fakeMcps([structuredClone(REGISTERED)]);

    const result = await syncToolsFromSnapshot(mcps, snapshot([]));

    expect(result.orphaned).toEqual(["mcp-url-fetch"]);
    // An MCP entry holds credentials; a file disappearing from a branch is not
    // enough to delete one.
    expect(removed).toEqual([]);
  });

  it("deletes an orphan only when the caller names it", async () => {
    const { mcps, removed, store } = fakeMcps([structuredClone(REGISTERED)]);

    const result = await syncToolsFromSnapshot(mcps, snapshot([]), { remove: ["mcp-url-fetch"] });

    expect(result.removed).toEqual(["mcp-url-fetch"]);
    expect(removed).toEqual(["mcp-url-fetch"]);
    expect(store.has("mcp-url-fetch")).toBe(false);
  });

  it("never lists an entry someone registered by hand", async () => {
    // It was never the repository's to miss, and listing it would park a delete
    // prompt next to it on every sync forever.
    const { mcps } = fakeMcps([
      {
        name: "typed-by-hand",
        url: "https://a.example.com/mcp",
        description: "",
        headers: {},
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);

    const result = await syncToolsFromSnapshot(mcps, snapshot([]), { remove: ["typed-by-hand"] });

    expect(result.orphaned).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it("skips a document with no url and still syncs the rest of the snapshot", async () => {
    const { mcps } = fakeMcps();
    const result = await syncToolsFromSnapshot(
      mcps,
      snapshot([
        { name: "broken", content: "---\ndescription: no address\n---\nbody" },
        { name: "mcp-url-fetch", content: FETCHER },
      ]),
    );

    expect(result.created).toEqual(["mcp-url-fetch"]);
    expect(result.skipped).toEqual([{ name: "broken", reason: "missing-url" }]);
  });

  it("keeps a stored url when the document has none", async () => {
    const { mcps, store } = fakeMcps([
      {
        name: "mcp-url-fetch",
        url: "https://kept.example.com/mcp",
        description: "old",
        content: "",
        headers: {},
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);

    const result = await syncToolsFromSnapshot(
      mcps,
      snapshot([{ name: "mcp-url-fetch", content: "---\ndescription: new\n---\nnotes" }]),
      { overwrite: ["mcp-url-fetch"] },
    );

    expect(result.skipped).toEqual([]);
    expect(store.get("mcp-url-fetch")?.url).toBe("https://kept.example.com/mcp");
    expect(store.get("mcp-url-fetch")?.description).toBe("new");
  });

  it("reports a refused url with the guard's own message and keeps going", async () => {
    const { mcps } = fakeMcps([], {
      blocked: new ValidationError("URL resolves to a blocked address: 169.254.169.254"),
    });
    const result = await syncToolsFromSnapshot(
      mcps,
      snapshot([
        { name: "blocked", content: "---\nurl: http://169.254.169.254/mcp\n---\nbody" },
        { name: "mcp-url-fetch", content: FETCHER },
      ]),
    );

    expect(result.created).toEqual(["mcp-url-fetch"]);
    expect(result.skipped).toEqual([
      {
        name: "blocked",
        reason: "invalid-url",
        detail: "URL resolves to a blocked address: 169.254.169.254",
      },
    ]);
  });

  it("reports a name registered mid-sync as the race it is, not a bad url", async () => {
    const { mcps } = fakeMcps([], { "mcp-url-fetch": new ConflictError("MCP server already exists") });
    const result = await syncToolsFromSnapshot(mcps, snapshot([{ name: "mcp-url-fetch", content: FETCHER }]));

    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual([{ name: "mcp-url-fetch", reason: "conflict" }]);
  });

  it("reports a directory the client could not turn into an entry name", async () => {
    const { mcps } = fakeMcps();
    const result = await syncToolsFromSnapshot(mcps, snapshot([], ["tools/Not A Slug/TOOL.md"]));

    expect(result.skipped).toEqual([{ name: "tools/Not A Slug/TOOL.md", reason: "bad-name" }]);
  });

  it("lets an unexpected failure surface instead of reporting it as a skip", async () => {
    const { mcps } = fakeMcps([], { "mcp-url-fetch": new Error("DynamoDB unavailable") });
    await expect(
      syncToolsFromSnapshot(mcps, snapshot([{ name: "mcp-url-fetch", content: FETCHER }])),
    ).rejects.toThrow("DynamoDB unavailable");
  });

  it("carries the commit it synced, so a result names what it came from", async () => {
    const { mcps } = fakeMcps();
    const result = await syncToolsFromSnapshot(mcps, snapshot([{ name: "mcp-url-fetch", content: FETCHER }]));

    expect(result.repo).toBe("opspresso/agent-tools");
    expect(result.commitSha).toBe("abc123");
  });

  it("writes once and reports the entry as in step thereafter", async () => {
    const { mcps, created, patched } = fakeMcps();
    const files = [{ name: "mcp-url-fetch", content: FETCHER }];

    await syncToolsFromSnapshot(mcps, snapshot(files));
    const second = await syncToolsFromSnapshot(mcps, snapshot(files), {
      overwrite: ["mcp-url-fetch"],
    });

    expect(second.existing).toEqual([{ name: "mcp-url-fetch", differs: [] }]);
    expect(created).toHaveLength(1);
    expect(patched).toEqual([]);
  });
});
