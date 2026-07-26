/**
 * GitHub client for the skills source repository. Scans the repo tree for
 * `<dir>/SKILL.md` files (conventionally under `skills/`), where the parent
 * directory name is the skill slug, and collects supported text attachment
 * files beneath each skill root.
 */

import type { RepoSkillFile, SkillFile, SkillsRepoSnapshot } from "@/domain/skill/types";
import {
  selectSkillAttachments,
  type SkillRoot,
  type SkillTreeEntry,
} from "@/domain/skill/files";

export type { RepoSkillFile, SkillsRepoSnapshot };

const SLUG = /^[a-z0-9-]+$/;

async function githubApi<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub ${path} failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

async function fetchBlobText(repo: string, sha: string, token: string): Promise<string> {
  const blob = await githubApi<{ content: string; encoding: string }>(
    `/repos/${repo}/git/blobs/${sha}`,
    token,
  );
  return blob.encoding === "base64"
    ? Buffer.from(blob.content, "base64").toString("utf8")
    : blob.content;
}

export async function fetchSkillsRepoSnapshot(
  { repo, branch, token }: { repo?: string; branch: string; token?: string },
): Promise<SkillsRepoSnapshot> {
  if (!repo || !token) {
    throw new Error("SKILLS_REPO and GITHUB_TOKEN must be configured");
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
    throw new Error("Skills repo tree is truncated; repository too large to sync");
  }

  const roots: SkillRoot[] = [];
  for (const entry of tree.tree) {
    if (entry.type !== "blob" || !entry.path.endsWith("/SKILL.md")) {
      continue;
    }
    const parts = entry.path.split("/");
    const name = parts[parts.length - 2] ?? "";
    if (!SLUG.test(name)) {
      continue;
    }
    roots.push({ name, rootPath: parts.slice(0, -1).join("/"), skillMdPath: entry.path });
  }

  const { selected, skipped } = selectSkillAttachments(tree.tree, roots);
  const attachmentsByName = new Map<string, SkillFile[]>();
  for (const attachment of selected) {
    const content = await fetchBlobText(repo, attachment.sha, token);
    const list = attachmentsByName.get(attachment.name) ?? [];
    list.push({ path: attachment.relPath, content });
    attachmentsByName.set(attachment.name, list);
  }

  const files: RepoSkillFile[] = [];
  for (const root of roots) {
    const skillMd = tree.tree.find((entry) => entry.path === root.skillMdPath);
    if (!skillMd) {
      continue;
    }
    const content = await fetchBlobText(repo, skillMd.sha, token);
    files.push({
      name: root.name,
      path: root.skillMdPath,
      content,
      files: attachmentsByName.get(root.name) ?? [],
    });
  }

  return { repo, branch, commitSha, files, skipped };
}
