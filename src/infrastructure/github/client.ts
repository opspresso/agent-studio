/**
 * The GitHub REST access the plugins sync needs: read a repository's tree,
 * read a blob. Kept apart from the plugins client so the API version pinned
 * and how a base64 blob is decoded stay decided once, whatever reads a repo
 * next. The host comes from `GITHUB_API_URL`, so a GitHub Enterprise Server
 * or an on-premises mirror stands in for github.com without a second client.
 */

import { config } from "@/lib/config";

/** One entry of a recursive git tree listing. */
export interface GitTreeEntry {
  path: string;
  type: string;
  sha: string;
}

/**
 * Per-request deadline. Without one, a hung GitHub read holds the sync — and
 * the proxy in front of it — until something else gives up first; the known
 * failure mode is an ALB idle timeout cutting the response with the sync
 * half-reported.
 */
const GITHUB_TIMEOUT_MS = 15_000;

export async function githubApi<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${config.githubApiUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
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
