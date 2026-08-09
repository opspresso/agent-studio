/**
 * GitHub client for the Agent Plugins source repository. Finds every plugin
 * root (`plugin.json` anywhere in the tree), and collects per root what the
 * spec fixes in place: `skills/<name>/SKILL.md` with attachments, `mcp.json`,
 * and this org's extension documents. Raw fetch only — plugin.json and
 * mcp.json come back as strings, because interpreting them is the domain's
 * job (`@/domain/plugin/types`), not this client's.
 */

import type { SkillFile } from "@/domain/skill/types";
import { selectSkillAttachments, type SkillTreeEntry } from "@/domain/skill/files";
import { isSlug } from "@/shared/slug";
import {
  excludeSubtrees,
  mcpDocServerName,
  selectPluginRoots,
  selectPluginSkillRoots,
} from "@/domain/plugin/files";
import type {
  PluginsRepoSnapshot,
  RepoPlugin,
  RepoPluginDoc,
  RepoPluginSkill,
} from "@/domain/plugin/sync";
import { fetchBlobText, githubApi } from "./client";

export async function fetchPluginsRepoSnapshot(
  { repo, branch, token }: { repo?: string; branch: string; token?: string },
): Promise<PluginsRepoSnapshot> {
  if (!repo || !token) {
    throw new Error("PLUGINS_REPO and GITHUB_TOKEN must be configured");
  }

  const ref = await githubApi<{ object: { sha: string } }>(
    `/repos/${repo}/git/ref/heads/${branch}`,
    token,
  );
  const commitSha = ref.object.sha;
  const commit = await githubApi<{ tree: { sha: string } }>(
    `/repos/${repo}/git/commits/${commitSha}`,
    token,
  );
  const tree = await githubApi<{
    tree: SkillTreeEntry[];
    truncated: boolean;
  }>(`/repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`, token);
  if (tree.truncated) {
    throw new Error("Plugins repo tree is truncated; repository too large to sync");
  }

  const { roots, nested } = selectPluginRoots(tree.tree);
  // A nested root is refused whole: none of its files may double as an outer
  // plugin's skill or attachment, or one repo would mean two things.
  const entries = excludeSubtrees(tree.tree, nested);

  const plugins: RepoPlugin[] = [];
  for (const root of roots) {
    const manifestEntry = entries.find((entry) => entry.path === root.manifestPath);
    if (!manifestEntry) {
      continue;
    }
    const manifestRaw = await fetchBlobText(repo, manifestEntry.sha, token);

    const mcpJsonPath = root.rootPath === "" ? "mcp.json" : `${root.rootPath}/mcp.json`;
    const mcpJsonEntry = entries.find(
      (entry) => entry.type === "blob" && entry.path === mcpJsonPath,
    );
    const mcpJsonRaw = mcpJsonEntry
      ? await fetchBlobText(repo, mcpJsonEntry.sha, token)
      : undefined;

    // A directory name that is not a slug cannot become a registry entry name.
    // Reported rather than dropped: a document nobody ever sees is the failure
    // the plugin convention exists to prevent.
    const discovered = selectPluginSkillRoots(root, entries);
    const skillRoots = discovered.filter((candidate) => isSlug(candidate.name));
    const badNames = discovered
      .filter((candidate) => !isSlug(candidate.name))
      .map((candidate) => candidate.skillMdPath);
    const { selected, skipped } = selectSkillAttachments(entries, skillRoots);
    const attachmentsByName = new Map<string, SkillFile[]>();
    for (const attachment of selected) {
      const content = await fetchBlobText(repo, attachment.sha, token);
      const list = attachmentsByName.get(attachment.name) ?? [];
      list.push({ path: attachment.relPath, content });
      attachmentsByName.set(attachment.name, list);
    }

    const skills: RepoPluginSkill[] = [];
    for (const skillRoot of skillRoots) {
      const skillMd = entries.find((entry) => entry.path === skillRoot.skillMdPath);
      if (!skillMd) {
        continue;
      }
      skills.push({
        name: skillRoot.name,
        path: skillRoot.skillMdPath,
        content: await fetchBlobText(repo, skillMd.sha, token),
        files: attachmentsByName.get(skillRoot.name) ?? [],
      });
    }

    const mcpDocs: RepoPluginDoc[] = [];
    for (const entry of entries) {
      if (entry.type !== "blob") {
        continue;
      }
      const server = mcpDocServerName(entry.path, root);
      if (server === null) {
        continue;
      }
      mcpDocs.push({
        server,
        path: entry.path,
        content: await fetchBlobText(repo, entry.sha, token),
      });
    }

    plugins.push({
      rootPath: root.rootPath,
      manifestRaw,
      mcpJsonRaw,
      skills,
      mcpDocs,
      skippedAttachments: skipped,
      badSkillDirs: badNames,
    });
  }

  return {
    repo,
    branch,
    commitSha,
    plugins,
    nestedRoots: nested.map((root) => root.manifestPath),
  };
}
