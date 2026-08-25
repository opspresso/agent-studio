import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPluginsRepoSnapshot } from "@/infrastructure/github/pluginsRepoClient";
import {
  collectRepoPlugins,
  MAX_CONCURRENT_PLUGIN_READS,
} from "@/infrastructure/plugin/snapshot";

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
  mode?: string;
  size?: number;
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

const CONFIG = { repo: "opspresso/agent-plugins", branch: "main", token: "gh-token" };

function blob(path: string, size = 10): TreeEntry {
  return { path, type: "blob", sha: `sha:${path}`, size };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchPluginsRepoSnapshot", () => {
  it("bounds selected blob reads within a plugin", async () => {
    let active = 0;
    let maxActive = 0;
    const paths = [
      "plugin.json",
      ...Array.from(
        { length: MAX_CONCURRENT_PLUGIN_READS + 2 },
        (_, index) => `skills/skill-${index}/SKILL.md`,
      ),
    ];

    const snapshot = await collectRepoPlugins(
      paths.map((path) => ({
        path,
        size: 10,
        async read() {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await Promise.resolve();
          active -= 1;
          return path === "plugin.json" ? '{"name":"root"}' : "---\ndescription: test\n---";
        },
      })),
    );

    expect(maxActive).toBe(MAX_CONCURRENT_PLUGIN_READS);
    expect(snapshot.plugins[0]?.skills).toHaveLength(MAX_CONCURRENT_PLUGIN_READS + 2);
  });

  it("collects each plugin root's manifest, skills with attachments, mcp.json and extension docs", async () => {
    stubGitHub(
      [
        blob("plugins/devops/plugin.json"),
        blob("plugins/devops/mcp.json"),
        blob("plugins/devops/skills/gitops/SKILL.md"),
        blob("plugins/devops/skills/gitops/references/api.md"),
        blob("plugins/devops/org.opspresso.agent-studio/mcp/argocd.md"),
        blob("plugins/research/plugin.json"),
        // No mcp.json, no skills — a missing fixed location is not an error.
        blob("README.md"),
      ],
      {
        "sha:plugins/devops/plugin.json": '{"name":"devops"}',
        "sha:plugins/devops/mcp.json": '{"mcpServers":{}}',
        "sha:plugins/devops/skills/gitops/SKILL.md": "gitops doc",
        "sha:plugins/devops/skills/gitops/references/api.md": "api reference",
        "sha:plugins/devops/org.opspresso.agent-studio/mcp/argocd.md": "argocd doc",
        "sha:plugins/research/plugin.json": '{"name":"research"}',
      },
    );

    const snapshot = await fetchPluginsRepoSnapshot(CONFIG);

    expect(snapshot.commitSha).toBe("commit-sha");
    expect(snapshot.nestedRoots).toEqual([]);
    expect(snapshot.plugins).toEqual([
      {
        rootPath: "plugins/devops",
        manifestRaw: '{"name":"devops"}',
        mcpJsonRaw: '{"mcpServers":{}}',
        skills: [
          {
            name: "gitops",
            path: "plugins/devops/skills/gitops/SKILL.md",
            content: "gitops doc",
            files: [{ path: "references/api.md", content: "api reference" }],
          },
        ],
        mcpDocs: [
          {
            server: "argocd",
            path: "plugins/devops/org.opspresso.agent-studio/mcp/argocd.md",
            content: "argocd doc",
          },
        ],
        skippedAttachments: [],
        badSkillDirs: [],
      },
      {
        rootPath: "plugins/research",
        manifestRaw: '{"name":"research"}',
        mcpJsonRaw: undefined,
        skills: [],
        mcpDocs: [],
        skippedAttachments: [],
        badSkillDirs: [],
      },
    ]);
  });

  it("refuses a nested plugin root and blinds the outer plugin to its subtree", async () => {
    stubGitHub(
      [
        blob("plugins/devops/plugin.json"),
        blob("plugins/devops/skills/inner/plugin.json"),
        blob("plugins/devops/skills/inner/SKILL.md"),
      ],
      { "sha:plugins/devops/plugin.json": '{"name":"devops"}' },
    );

    const snapshot = await fetchPluginsRepoSnapshot(CONFIG);

    expect(snapshot.nestedRoots).toEqual(["plugins/devops/skills/inner/plugin.json"]);
    expect(snapshot.plugins).toHaveLength(1);
    // The nested root's SKILL.md must not become the outer plugin's skill.
    expect(snapshot.plugins[0]?.skills).toEqual([]);
  });

  it("reports a skill directory whose name cannot be a registry entry name", async () => {
    stubGitHub(
      [
        blob("plugins/devops/plugin.json"),
        blob("plugins/devops/skills/Not A Slug/SKILL.md"),
      ],
      { "sha:plugins/devops/plugin.json": '{"name":"devops"}' },
    );

    const snapshot = await fetchPluginsRepoSnapshot(CONFIG);

    expect(snapshot.plugins[0]?.skills).toEqual([]);
    expect(snapshot.plugins[0]?.badSkillDirs).toEqual([
      "plugins/devops/skills/Not A Slug/SKILL.md",
    ]);
  });

  it("carries the attachment collector's skips", async () => {
    stubGitHub(
      [
        blob("plugins/devops/plugin.json"),
        blob("plugins/devops/skills/gitops/SKILL.md"),
        blob("plugins/devops/skills/gitops/scripts/run.sh"),
      ],
      {
        "sha:plugins/devops/plugin.json": '{"name":"devops"}',
        "sha:plugins/devops/skills/gitops/SKILL.md": "doc",
      },
    );

    const snapshot = await fetchPluginsRepoSnapshot(CONFIG);

    expect(snapshot.plugins[0]?.skippedAttachments).toEqual([
      { name: "gitops", path: "scripts/run.sh", reason: "unsupported-type" },
    ]);
  });

  it("throws when the tree is truncated rather than syncing part of a repository", async () => {
    stubGitHub([blob("plugin.json")], { "sha:plugin.json": "{}" }, true);
    await expect(fetchPluginsRepoSnapshot(CONFIG)).rejects.toThrow(/truncated/);
  });

  it("names the missing configuration when repo or token is absent", async () => {
    await expect(
      fetchPluginsRepoSnapshot({ repo: undefined, branch: "main", token: "t" }),
    ).rejects.toThrow(/PLUGINS_REPO and GITHUB_TOKEN/);
    await expect(
      fetchPluginsRepoSnapshot({ repo: "o/r", branch: "main", token: undefined }),
    ).rejects.toThrow(/PLUGINS_REPO and GITHUB_TOKEN/);
  });

  it("surfaces a GitHub failure with its status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 403 })));
    await expect(fetchPluginsRepoSnapshot(CONFIG)).rejects.toThrow(/403/);
  });
});
