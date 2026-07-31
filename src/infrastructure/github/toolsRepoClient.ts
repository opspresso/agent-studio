/**
 * GitHub client for the tools source repository. Scans the repo tree for
 * `<dir>/TOOL.md` files (conventionally under `tools/`), where the parent
 * directory name is the registry entry name.
 */

import type { RepoToolFile, ToolsRepoSnapshot } from "@/domain/mcp/toolsRepo";
import { isSlug } from "@/shared/slug";
import { fetchBlobText, githubApi, type GitTreeEntry } from "./client";

export type { RepoToolFile, ToolsRepoSnapshot };


export async function fetchToolsRepoSnapshot({
  repo,
  branch,
  token,
}: {
  repo?: string;
  branch: string;
  token?: string;
}): Promise<ToolsRepoSnapshot> {
  if (!repo || !token) {
    throw new Error("TOOLS_REPO and GITHUB_TOKEN must be configured");
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
    tree: GitTreeEntry[];
    truncated: boolean;
  }>(`/repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`, token);
  if (tree.truncated) {
    throw new Error("Tools repo tree is truncated; repository too large to sync");
  }

  const files: RepoToolFile[] = [];
  const skippedPaths: string[] = [];
  for (const entry of tree.tree) {
    if (entry.type !== "blob" || !entry.path.endsWith("/TOOL.md")) {
      continue;
    }
    const parts = entry.path.split("/");
    const name = parts[parts.length - 2] ?? "";
    // A directory name that is not a slug cannot become a registry entry name.
    // Reported rather than dropped: a document nobody ever sees is the failure
    // this repository's convention exists to prevent.
    if (!isSlug(name)) {
      skippedPaths.push(entry.path);
      continue;
    }
    files.push({ name, path: entry.path, content: await fetchBlobText(repo, entry.sha, token) });
  }

  return { repo, branch, commitSha, files, skippedPaths };
}
