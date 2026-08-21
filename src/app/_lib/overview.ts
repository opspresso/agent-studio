/** Shared helpers for the signed-in overview. */

import type { Project } from "@/domain/project/types";

/**
 * The projects to offer as "pick up where you left off".
 *
 * The viewer's own come first, and only then everyone else's — the catalog is
 * shared, so a workspace where somebody else has been busier would otherwise
 * push the reader's own work off a four-card list entirely. Within each group
 * the newest edit wins.
 *
 * Chats need no counterpart: `listChats` returns them newest-first from the
 * `CHATOWNER#{email}` GSI, and they are the viewer's own by definition.
 */
export function recentProjects<T extends Pick<Project, "ownerEmail" | "updatedAt">>(
  projects: T[],
  viewerEmail: string | null,
  limit: number,
): T[] {
  const byRecency = (a: T, b: T) => b.updatedAt.localeCompare(a.updatedAt);
  const isMine = (project: T) =>
    viewerEmail !== null && project.ownerEmail === viewerEmail;
  const mine = projects.filter(isMine).sort(byRecency);
  const others = projects.filter((project) => !isMine(project)).sort(byRecency);
  return [...mine, ...others].slice(0, limit);
}
