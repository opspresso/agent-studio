/** Shared helpers for the signed-in overview. */

import type { Agent } from "@/domain/agent/types";

/**
 * The agents to offer as "pick up where you left off".
 *
 * The viewer's own come first, and only then everyone else's — the catalog is
 * shared, so a workspace where somebody else has been busier would otherwise
 * push the reader's own work off a four-card list entirely. Within each group
 * the newest edit wins.
 *
 * Chats need no counterpart: `listChats` returns them newest-first from the
 * `CHATOWNER#{email}` GSI, and they are the viewer's own by definition.
 */
export function recentAgents<T extends Pick<Agent, "ownerEmail" | "updatedAt">>(
  agents: T[],
  viewerEmail: string | null,
  limit: number,
): T[] {
  const byRecency = (a: T, b: T) => b.updatedAt.localeCompare(a.updatedAt);
  const isMine = (agent: T) =>
    viewerEmail !== null && agent.ownerEmail === viewerEmail;
  const mine = agents.filter(isMine).sort(byRecency);
  const others = agents.filter((agent) => !isMine(agent)).sort(byRecency);
  return [...mine, ...others].slice(0, limit);
}
