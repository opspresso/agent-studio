import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchToolsRepoSnapshot } from "@/infrastructure/github/toolsRepoClient";

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
}

/** A GitHub that answers the three reads a snapshot needs, plus blobs by sha. */
function stubGitHub(entries: TreeEntry[], blobs: Record<string, string>, truncated = false) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      if (url.includes("/git/ref/heads/")) {
        return json({ object: { sha: "commit-sha" } });
      }
      if (url.includes("/git/commits/")) {
        return json({ tree: { sha: "tree-sha" } });
      }
      if (url.includes("/git/trees/")) {
        return json({ tree: entries, truncated });
      }
      const blobSha = /\/git\/blobs\/(.+)$/.exec(url)?.[1] ?? "";
      const content = blobs[blobSha];
      if (content === undefined) {
        return new Response("not found", { status: 404 });
      }
      return json({ content: Buffer.from(content, "utf8").toString("base64"), encoding: "base64" });
    }),
  );
}

const CONFIG = { repo: "opspresso/agent-tools", branch: "main", token: "gh-token" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchToolsRepoSnapshot", () => {
  it("names each entry after its TOOL.md parent directory", async () => {
    stubGitHub(
      [
        { path: "tools/mcp-url-fetch/TOOL.md", type: "blob", sha: "sha-fetch" },
        { path: "tools/mcp-memory/TOOL.md", type: "blob", sha: "sha-memory" },
      ],
      { "sha-fetch": "fetch doc", "sha-memory": "memory doc" },
    );

    const snapshot = await fetchToolsRepoSnapshot(CONFIG);

    expect(snapshot.commitSha).toBe("commit-sha");
    expect(snapshot.files).toEqual([
      { name: "mcp-url-fetch", path: "tools/mcp-url-fetch/TOOL.md", content: "fetch doc" },
      { name: "mcp-memory", path: "tools/mcp-memory/TOOL.md", content: "memory doc" },
    ]);
    expect(snapshot.skippedPaths).toEqual([]);
  });

  it("ignores everything that is not a TOOL.md blob", async () => {
    stubGitHub(
      [
        { path: "README.md", type: "blob", sha: "sha-readme" },
        { path: "tools/mcp-memory", type: "tree", sha: "sha-dir" },
        { path: "tools/mcp-memory/notes.md", type: "blob", sha: "sha-notes" },
        { path: "tools/mcp-memory/TOOL.md", type: "blob", sha: "sha-memory" },
      ],
      { "sha-memory": "memory doc" },
    );

    const snapshot = await fetchToolsRepoSnapshot(CONFIG);

    expect(snapshot.files.map((file) => file.name)).toEqual(["mcp-memory"]);
  });

  it("reports a directory whose name cannot be a registry entry name", async () => {
    stubGitHub([{ path: "tools/Not A Slug/TOOL.md", type: "blob", sha: "sha-bad" }], {});

    const snapshot = await fetchToolsRepoSnapshot(CONFIG);

    expect(snapshot.files).toEqual([]);
    expect(snapshot.skippedPaths).toEqual(["tools/Not A Slug/TOOL.md"]);
  });

  it("refuses a truncated tree rather than syncing part of the repo", async () => {
    stubGitHub([{ path: "tools/mcp-memory/TOOL.md", type: "blob", sha: "sha-memory" }], {}, true);

    await expect(fetchToolsRepoSnapshot(CONFIG)).rejects.toThrow("truncated");
  });

  it("fails loudly when the repo or token is missing", async () => {
    await expect(fetchToolsRepoSnapshot({ branch: "main", token: "gh-token" })).rejects.toThrow(
      "TOOLS_REPO",
    );
    await expect(
      fetchToolsRepoSnapshot({ repo: "opspresso/agent-tools", branch: "main" }),
    ).rejects.toThrow("GITHUB_TOKEN");
  });

  it("surfaces a GitHub failure with its status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));

    await expect(fetchToolsRepoSnapshot(CONFIG)).rejects.toThrow("failed: 404");
  });
});
