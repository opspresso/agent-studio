import type { VersionRepository } from "@/domain/project/repository";
import type { Project, Version } from "@/domain/project/types";

/**
 * Resolve the version a run should execute — the single owner of this rule.
 *
 * The published pointer always wins. `allowDraftFallback` lets interactive
 * surfaces (the chat playground) fall back to the newest draft by `createdAt`
 * when nothing is published; external surfaces (Slack, A2A, subagent
 * transfers) must not leak drafts and leave it off. Returns `null` when
 * nothing is runnable under the chosen policy.
 */
export async function resolveRunnableVersion(
  versions: VersionRepository,
  project: Project,
  opts: { allowDraftFallback?: boolean } = {},
): Promise<Version | null> {
  const published = await versions.get(project.name, "published");
  if (published) {
    return published;
  }
  if (!opts.allowDraftFallback) {
    return null;
  }
  const all = await versions.list(project.name);
  if (all.length === 0) {
    return null;
  }
  return [...all].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[all.length - 1] ?? null;
}
