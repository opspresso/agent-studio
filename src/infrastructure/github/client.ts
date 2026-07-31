/**
 * The GitHub REST access both sync paths need: read a repository's tree, read a
 * blob. Shared so the skills and tools clients cannot disagree about the API
 * version they pin or how a base64 blob is decoded.
 */

/** One entry of a recursive git tree listing. */
export interface GitTreeEntry {
  path: string;
  type: string;
  sha: string;
}

export async function githubApi<T>(path: string, token: string): Promise<T> {
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

export async function fetchBlobText(repo: string, sha: string, token: string): Promise<string> {
  const blob = await githubApi<{ content: string; encoding: string }>(
    `/repos/${repo}/git/blobs/${sha}`,
    token,
  );
  return blob.encoding === "base64"
    ? Buffer.from(blob.content, "base64").toString("utf8")
    : blob.content;
}
