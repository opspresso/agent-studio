import type { VersionRepository } from "@/domain/project/repository";
import type { Project, Version } from "@/domain/project/types";
import { listVersions } from "./versionUseCases";

/**
 * Resolve the version a run should execute — the single owner of this rule.
 *
 * The published pointer always wins. `allowDraftFallback` lets interactive
 * surfaces (the chat playground) fall back to the newest draft by `createdAt`
 * when nothing is published; external surfaces (Slack, A2A, subagent
 * transfers) must not leak drafts and leave it off. Returns `null` when
 * nothing is runnable under the chosen policy.
 *
 * The pointer is read off the project the caller already holds, not through the
 * repository's `"published"` sentinel: that sentinel re-reads the project item
 * to resolve the same value, which on a polled external surface like the A2A
 * Agent Card is a wasted round trip per request.
 */
export async function resolveRunnableVersion(
  versions: VersionRepository,
  project: Project,
  opts: { allowDraftFallback?: boolean } = {},
): Promise<Version | null> {
  const published = project.publishedVersion
    ? await versions.get(project.name, project.publishedVersion)
    : null;
  if (published) {
    return published;
  }
  if (!opts.allowDraftFallback) {
    return null;
  }
  const all = await listVersions(versions, project.name);
  if (all.length === 0) {
    return null;
  }
  return [...all].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[all.length - 1] ?? null;
}
