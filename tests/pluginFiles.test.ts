import { describe, expect, it } from "vitest";
import {
  excludeSubtrees,
  mcpDocServerName,
  selectPluginRoots,
  selectPluginSkillRoots,
  type PluginRoot,
} from "@/domain/plugin/files";
import type { SkillTreeEntry } from "@/domain/skill/files";

function blob(path: string): SkillTreeEntry {
  return { path, type: "blob", sha: `sha-${path}` };
}

describe("selectPluginRoots", () => {
  it("finds a plugin root anywhere in the tree, including the repository root", () => {
    const { roots, nested } = selectPluginRoots([
      blob("plugin.json"),
      blob("README.md"),
    ]);
    expect(roots).toEqual([{ rootPath: "", manifestPath: "plugin.json" }]);
    expect(nested).toEqual([]);
  });

  it("finds every monorepo plugin", () => {
    const { roots } = selectPluginRoots([
      blob("plugins/devops/plugin.json"),
      blob("plugins/research/plugin.json"),
      blob("plugins/devops/skills/gitops/SKILL.md"),
    ]);
    expect(roots.map((root) => root.rootPath)).toEqual(["plugins/devops", "plugins/research"]);
  });

  it("refuses a root nested inside another root", () => {
    const { roots, nested } = selectPluginRoots([
      blob("plugins/devops/plugin.json"),
      blob("plugins/devops/skills/inner/plugin.json"),
    ]);
    expect(roots.map((root) => root.rootPath)).toEqual(["plugins/devops"]);
    expect(nested).toEqual([
      {
        rootPath: "plugins/devops/skills/inner",
        manifestPath: "plugins/devops/skills/inner/plugin.json",
      },
    ]);
  });

  it("treats every directory plugin as nested when the repo root is one", () => {
    const { roots, nested } = selectPluginRoots([
      blob("plugin.json"),
      blob("plugins/devops/plugin.json"),
    ]);
    expect(roots.map((root) => root.rootPath)).toEqual([""]);
    expect(nested.map((root) => root.rootPath)).toEqual(["plugins/devops"]);
  });
});

describe("excludeSubtrees", () => {
  it("drops everything under the given roots", () => {
    const entries = [
      blob("plugins/devops/plugin.json"),
      blob("plugins/devops/skills/inner/plugin.json"),
      blob("plugins/devops/skills/inner/skills/x/SKILL.md"),
    ];
    const scoped = excludeSubtrees(entries, [
      { rootPath: "plugins/devops/skills/inner", manifestPath: "plugins/devops/skills/inner/plugin.json" },
    ]);
    expect(scoped.map((entry) => entry.path)).toEqual(["plugins/devops/plugin.json"]);
  });

  it("returns the entries untouched with no roots to exclude", () => {
    const entries = [blob("plugin.json")];
    expect(excludeSubtrees(entries, [])).toBe(entries);
  });
});

const DEVOPS: PluginRoot = { rootPath: "plugins/devops", manifestPath: "plugins/devops/plugin.json" };

describe("selectPluginSkillRoots", () => {
  it("discovers only immediate children of the plugin's skills directory", () => {
    const roots = selectPluginSkillRoots(DEVOPS, [
      blob("plugins/devops/skills/gitops-change/SKILL.md"),
      // Not an immediate child — the spec does not discover it.
      blob("plugins/devops/skills/nested/deeper/SKILL.md"),
      // Another plugin's skill.
      blob("plugins/research/skills/other/SKILL.md"),
      // Not a SKILL.md.
      blob("plugins/devops/skills/gitops-change/references/api.md"),
    ]);
    expect(roots).toEqual([
      {
        name: "gitops-change",
        rootPath: "plugins/devops/skills/gitops-change",
        skillMdPath: "plugins/devops/skills/gitops-change/SKILL.md",
      },
    ]);
  });

  it("works for a repository-root plugin", () => {
    const roots = selectPluginSkillRoots({ rootPath: "", manifestPath: "plugin.json" }, [
      blob("skills/greet/SKILL.md"),
    ]);
    expect(roots.map((root) => root.name)).toEqual(["greet"]);
  });

  it("returns a non-slug directory too — whether it may become a name is the caller's rule", () => {
    const roots = selectPluginSkillRoots(DEVOPS, [
      blob("plugins/devops/skills/Not A Slug/SKILL.md"),
    ]);
    expect(roots.map((root) => root.name)).toEqual(["Not A Slug"]);
  });
});

describe("mcpDocServerName", () => {
  it("names the server an extension document describes", () => {
    expect(
      mcpDocServerName("plugins/devops/org.opspresso.agent-studio/mcp/argocd.md", DEVOPS),
    ).toBe("argocd");
  });

  it("matches at the repository root", () => {
    expect(
      mcpDocServerName("org.opspresso.agent-studio/mcp/memory.md", {
        rootPath: "",
        manifestPath: "plugin.json",
      }),
    ).toBe("memory");
  });

  it.each([
    ["another plugin's document", "plugins/research/org.opspresso.agent-studio/mcp/argocd.md"],
    ["a non-markdown file", "plugins/devops/org.opspresso.agent-studio/mcp/argocd.json"],
    ["a nested path", "plugins/devops/org.opspresso.agent-studio/mcp/deep/argocd.md"],
    ["an unrelated directory", "plugins/devops/docs/argocd.md"],
  ])("answers null for %s", (_case, path) => {
    expect(mcpDocServerName(path, DEVOPS)).toBeNull();
  });
});
