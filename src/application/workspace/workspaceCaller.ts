import type { RunOrigin } from "@/domain/execution/actor";
import { mcpUserEmail } from "@/application/mcpMetadataHeaders";

/** Surface authentication owns identity resolution; never infer a Studio user from an actor email. */
export function workspaceCaller(origin: Partial<RunOrigin>) {
  const ownerEmail = mcpUserEmail(origin.actor, origin.userEmail);
  return origin.actor && origin.user?.userId && origin.user.email === ownerEmail
    ? { user: origin.user, ownerEmail, actor: origin.actor,
      ...(origin.executionGrant ? { executionGrant: origin.executionGrant } : {}) }
    : undefined;
}
