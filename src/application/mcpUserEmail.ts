import type { RunActor } from "@/domain/execution/actor";

export const USER_EMAIL_HEADER = "X-User-Email";

export function mcpUserEmail(
  actor: RunActor | undefined,
  resolvedUserEmail?: string,
): string | undefined {
  if (actor?.kind === "user" || actor?.kind === "project-token") {
    const email = actor.id.trim().toLowerCase();
    return email || undefined;
  }
  const email = resolvedUserEmail?.trim().toLowerCase();
  return email || undefined;
}

export function applyMcpUserEmail(
  headers: Record<string, string>,
  email: string | undefined,
): void {
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === USER_EMAIL_HEADER.toLowerCase()) {
      delete headers[name];
    }
  }
  const normalized = email?.trim().toLowerCase();
  if (normalized) {
    headers[USER_EMAIL_HEADER] = normalized;
  }
}
