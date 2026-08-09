/**
 * The console's refusal to mutate a repo-owned registry entry — the single
 * owner of that rule, imported by every console route that mutates skills or
 * MCP servers.
 *
 * The rule lives at the route layer on purpose. The plugins sync legitimately
 * updates and deletes exactly these entries through the same use cases
 * (takeover, orphan removal), so "entries with a source are immutable" is not
 * a property of the entity — it is a policy about *this surface*: the console
 * does not compete with the repository over what the repository declared.
 * Credentials are the carve-out — headers and OAuth are console-owned and
 * never in git — so a caller gates only the document fields it names.
 */
export function repoOwnedRefusal(
  entity: { source?: string },
  action: string,
): Response | null {
  if (!entity.source) {
    return null;
  }
  return Response.json(
    {
      error: `This entry is owned by ${entity.source} — ${action}`,
    },
    { status: 403 },
  );
}

/** The standard wordings, so two routes cannot drift apart. */
export const REPO_OWNED = {
  edit: "change its document in the repository; the sync applies it.",
  remove: "delete it by removing it from the repository and applying the sync's orphan removal.",
} as const;
