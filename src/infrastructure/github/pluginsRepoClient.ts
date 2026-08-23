/**
 * GitHub client for the Agent Plugins source repository: the branch head,
 * the recursive tree, and a blob read per file the walker asks for. Which
 * directories mean what is `@/infrastructure/plugin/snapshot` — shared with
 * the archive upload, so this file is only how GitHub lists and reads.
 */

import type { SkillTreeEntry } from "@/domain/skill/files";
import type { PluginsRepoSnapshot } from "@/domain/plugin/sync";
import { collectRepoPlugins, type PluginTreeFile } from "@/infrastructure/plugin/snapshot";
import { fetchBlobText, githubApi } from "./client";

/**
 * Just the branch head, for the tick's is-anything-new check — one API call
 * against the ~30 a full snapshot costs, which is what makes a once-a-minute
 * tick affordable.
 */
export async function fetchRepoHeadSha(
  { repo, branch, token }: { repo?: string; branch: string; token?: string },
): Promise<string> {
  if (!repo || !token) {
    throw new Error("PLUGINS_REPO and GITHUB_TOKEN must be configured");
  }
  const ref = await githubApi<{ object: { sha: string } }>(
    `/repos/${repo}/git/ref/heads/${branch}`,
    token,
  );
  return ref.object.sha;
}

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

  // Blobs only: a `tree` row is implied by its files' paths, and a `commit`
  // row (a submodule) holds nothing this repository can read.
  const files: PluginTreeFile[] = tree.tree
    .filter((entry) => entry.type === "blob")
    .map((entry) => ({
      path: entry.path,
      size: entry.size ?? 0,
      ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
      read: () => fetchBlobText(repo, entry.sha, token),
    }));

  const { plugins, nestedRoots } = await collectRepoPlugins(files);
  return { repo, branch, commitSha, plugins, nestedRoots };
}
