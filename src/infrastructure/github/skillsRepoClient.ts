/**
 * GitHub client for the skills source repository. Scans the repo tree for
 * `<dir>/SKILL.md` files (conventionally under `skills/`), where the parent
 * directory name is the skill slug.
 */

import { getSkillsRepoConfig } from "@/lib/runtime-settings";

export interface RepoSkillFile {
  /** Skill slug — the SKILL.md parent directory name. */
  name: string;
  path: string;
  content: string;
}

export interface SkillsRepoSnapshot {
  repo: string;
  branch: string;
  commitSha: string;
  files: RepoSkillFile[];
}

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

export async function fetchSkillsRepoSnapshot(): Promise<SkillsRepoSnapshot> {
  const { repo, branch, token } = await getSkillsRepoConfig();
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
    tree: Array<{ path: string; type: string; sha: string }>;
    truncated: boolean;
  }>(`/repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`, token);
  if (tree.truncated) {
    throw new Error("Skills repo tree is truncated; repository too large to sync");
  }

  const skillFiles = tree.tree.filter(
    (entry) => entry.type === "blob" && entry.path.endsWith("/SKILL.md"),
  );

  const files: RepoSkillFile[] = [];
  for (const entry of skillFiles) {
    const parts = entry.path.split("/");
    const name = parts[parts.length - 2] ?? "";
    if (!SLUG.test(name)) {
      continue;
    }
    const blob = await githubApi<{ content: string; encoding: string }>(
      `/repos/${repo}/git/blobs/${entry.sha}`,
      token,
    );
    const content =
      blob.encoding === "base64"
        ? Buffer.from(blob.content, "base64").toString("utf8")
        : blob.content;
    files.push({ name, path: entry.path, content });
  }

  return { repo, branch, commitSha, files };
}
