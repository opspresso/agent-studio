import { describe, expect, it } from "vitest";
import { parseToolDoc, syncToolsFromSnapshot } from "@/application/mcp/syncTools";
import type { CreateMcpInput, McpUseCases } from "@/application/mcp/mcpUseCases";
import type { ToolsRepoSnapshot } from "@/domain/mcp/toolsRepo";
import type { McpServer } from "@/domain/mcp/types";
import { ConflictError, ValidationError } from "@/application/errors";

const NOW = "2026-01-01T00:00:00.000Z";

/**
 * A registry that records what it was asked to create. `create` may be told to
 * throw for a given name, which is how the guard's refusals are exercised
 * without wiring an SSRF policy through this test.
 */
function fakeMcps(existing: McpServer[] = [], refuse: Record<string, Error> = {}) {
  const store = new Map(existing.map((server) => [server.name, server]));
  const created: CreateMcpInput[] = [];
  const mcps: Pick<McpUseCases, "list" | "create"> = {
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
  };
  return { mcps, created, store };
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
  it("registers a tool the registry does not have", async () => {
    const { mcps, created } = fakeMcps();
    const result = await syncToolsFromSnapshot(mcps, snapshot([{ name: "mcp-url-fetch", content: FETCHER }]));

    expect(result.created).toEqual(["mcp-url-fetch"]);
    expect(result.skipped).toEqual([]);
    expect(created[0]).toEqual({
      name: "mcp-url-fetch",
      url: "http://mcp-url-fetch.agent-mcps.svc.cluster.local:8080/mcp",
      description: "Fetches pages",
      content: "# mcp-url-fetch\n\nOperator notes.",
      source: "github:opspresso/agent-tools",
      // Never from the repo: a secret does not belong in git.
      headers: {},
    });
  });

  it("leaves an existing entry byte-identical — the stored row wins", async () => {
    // Everything a sync must not destroy: encrypted headers, a discovered OAuth
    // block, an edited description, a url someone corrected.
    const stored: McpServer = {
      name: "mcp-url-fetch",
      url: "https://corrected.example.com/mcp",
      description: "Edited in the console",
      content: "console notes",
      headers: { Authorization: "enc:v1:ciphertext" },
      auth: {
        type: "oauth2",
        resource: "https://corrected.example.com",
        authorizationServer: "https://as.example.com",
        authorizationEndpoint: "https://as.example.com/authorize",
        tokenEndpoint: "https://as.example.com/token",
        tokenEndpointAuthMethod: "none",
        discoveredAt: NOW,
      },
      createdAt: NOW,
      updatedAt: NOW,
    };
    const { mcps, created, store } = fakeMcps([structuredClone(stored)]);

    const result = await syncToolsFromSnapshot(mcps, snapshot([{ name: "mcp-url-fetch", content: FETCHER }]));

    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual([{ name: "mcp-url-fetch", reason: "exists" }]);
    expect(created).toEqual([]);
    expect(store.get("mcp-url-fetch")).toEqual(stored);
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

  it("treats a name registered mid-sync as existing rather than failing", async () => {
    const { mcps } = fakeMcps([], { "mcp-url-fetch": new ConflictError("MCP server already exists") });
    const result = await syncToolsFromSnapshot(mcps, snapshot([{ name: "mcp-url-fetch", content: FETCHER }]));

    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual([{ name: "mcp-url-fetch", reason: "exists" }]);
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
});
