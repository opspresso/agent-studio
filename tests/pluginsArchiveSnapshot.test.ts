import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { fetchPluginsRepoSnapshot } from "@/infrastructure/github/pluginsRepoClient";
import { snapshotFromArchive } from "@/infrastructure/plugin/archiveSnapshot";
import { writeTar, writeTarGz, type TarFixtureEntry } from "./tarFixture";

/**
 * One tree, expressed two ways. The GitHub side is the recursive tree plus
 * blobs by sha; the archive side is the same files in a tarball, under the
 * one-directory prefix `git archive --prefix` adds.
 */
const TREE: { path: string; content?: string; symlink?: boolean }[] = [
  { path: "README.md", content: "# plugins" },
  { path: "plugins/devops/plugin.json", content: '{"name":"devops"}' },
  { path: "plugins/devops/mcp.json", content: '{"mcpServers":{}}' },
  { path: "plugins/devops/skills/gitops/SKILL.md", content: "gitops doc" },
  { path: "plugins/devops/skills/gitops/references/api.md", content: "api reference" },
  { path: "plugins/devops/skills/gitops/scripts/run.sh", content: "#!/bin/sh" },
  { path: "plugins/devops/skills/gitops/link.md", symlink: true },
  { path: "plugins/devops/skills/Not A Slug/SKILL.md", content: "bad" },
  { path: "plugins/devops/org.opspresso.agent-studio/mcp/argocd.md", content: "argocd doc" },
  { path: "plugins/research/plugin.json", content: '{"name":"research"}' },
  { path: "plugins/research/skills/inner/plugin.json", content: '{"name":"inner"}' },
  { path: "plugins/research/skills/inner/SKILL.md", content: "inner doc" },
];

function stubGitHub(): void {
  const entries = TREE.map((file) => ({
    path: file.path,
    type: "blob",
    sha: `sha:${file.path}`,
    size: Buffer.byteLength(file.content ?? ""),
    ...(file.symlink ? { mode: "120000" } : {}),
  }));
  const blobs = new Map(TREE.map((file) => [`sha:${file.path}`, file.content ?? ""]));
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
        return json({ tree: entries, truncated: false });
      }
      const content = blobs.get(/\/git\/blobs\/(.+)$/.exec(url)?.[1] ?? "");
      return content === undefined
        ? new Response("not found", { status: 404 })
        : json({ content: Buffer.from(content, "utf8").toString("base64"), encoding: "base64" });
    }),
  );
}

const ARCHIVE_ENTRIES: TarFixtureEntry[] = [
  { path: "agent-plugins/", type: "dir" },
  ...TREE.map((file) =>
    file.symlink
      ? { path: `agent-plugins/${file.path}`, type: "symlink" as const }
      : { path: `agent-plugins/${file.path}`, content: file.content },
  ),
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("snapshotFromArchive", () => {
  it("drops the checkout directory even when its AppleDouble sidecar comes first", async () => {
    // bsdtar on a Mac writes `._<dir>` ahead of `<dir>/` — a slash-less first
    // entry — so the prefix has to be decided after the sidecars are gone.
    const withSidecars: TarFixtureEntry[] = [
      { path: "._agent-plugins", content: "\u0000\u0005\u0016\u0007" },
      ARCHIVE_ENTRIES[0]!,
      { path: "agent-plugins/._README.md", content: "\u0000\u0005\u0016\u0007" },
      ...ARCHIVE_ENTRIES.slice(1),
    ];
    const snapshot = await snapshotFromArchive(writeTarGz(withSidecars), "opspresso/agent-plugins");
    const plain = await snapshotFromArchive(writeTarGz(ARCHIVE_ENTRIES), "opspresso/agent-plugins");
    expect(snapshot.plugins.map((plugin) => plugin.rootPath)).toEqual(
      plain.plugins.map((plugin) => plugin.rootPath),
    );
    expect(snapshot.plugins.map((plugin) => plugin.rootPath).join()).not.toContain("agent-plugins/");
  });

  it("builds the snapshot the GitHub client builds from the same tree", async () => {
    stubGitHub();
    const fromGitHub = await fetchPluginsRepoSnapshot({
      repo: "opspresso/agent-plugins",
      branch: "main",
      token: "gh-token",
    });
    const archive = writeTarGz(ARCHIVE_ENTRIES);
    const fromArchive = await snapshotFromArchive(archive, "opspresso/agent-plugins");

    expect(fromArchive.plugins).toEqual(fromGitHub.plugins);
    expect(fromArchive.nestedRoots).toEqual(fromGitHub.nestedRoots);
    expect(fromArchive.repo).toBe("opspresso/agent-plugins");
    expect(fromArchive.branch).toBe("archive");
    expect(fromArchive.commitSha).toBe(createHash("sha256").update(archive).digest("hex"));

    // The tree is not trivial: both sides found the plugins, the attachment,
    // the doc, the nested root, the bad directory name and the two skips.
    expect(fromArchive.plugins.map((plugin) => plugin.rootPath)).toEqual([
      "plugins/devops",
      "plugins/research",
    ]);
    expect(fromArchive.nestedRoots).toEqual(["plugins/research/skills/inner/plugin.json"]);
    const devops = fromArchive.plugins[0];
    expect(devops?.skills.map((skill) => skill.files)).toEqual([
      [{ path: "references/api.md", content: "api reference" }],
    ]);
    expect(devops?.mcpDocs.map((doc) => doc.server)).toEqual(["argocd"]);
    expect(devops?.badSkillDirs).toEqual(["plugins/devops/skills/Not A Slug/SKILL.md"]);
    expect(devops?.skippedAttachments).toEqual([
      { name: "gitops", path: "link.md", reason: "symlink" },
      { name: "gitops", path: "scripts/run.sh", reason: "unsupported-type" },
    ]);
  });

  it("reads an archive with no prefix directory and a plain (uncompressed) one", async () => {
    const entries = ARCHIVE_ENTRIES.slice(1).map((entry) => ({
      ...entry,
      path: entry.path.slice("agent-plugins/".length),
    }));
    const plain = await snapshotFromArchive(writeTar(entries), "x/y");
    expect(plain.plugins.map((plugin) => plugin.rootPath)).toEqual([
      "plugins/devops",
      "plugins/research",
    ]);
  });

  it("refuses a selected file that is not UTF-8 text, naming it", async () => {
    const archive = writeTar([
      { path: "plugin.json", content: '{"name":"x"}' },
      { path: "skills/a/SKILL.md", content: "doc" },
      { path: "skills/a/notes.md", content: "café" },
    ]);
    // Corrupt the attachment's bytes in place: a lone continuation byte.
    const at = archive.indexOf(Buffer.from("café", "utf8"));
    archive[at + 3] = 0xff;
    archive[at + 4] = 0xff;
    await expect(snapshotFromArchive(archive, "x/y")).rejects.toThrow(
      /"skills\/a\/notes.md" is not UTF-8 text/,
    );
  });
});
