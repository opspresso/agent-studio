import type { RunOrigin } from "@/domain/execution/actor";
import { mcpUserEmail } from "@/application/mcpMetadataHeaders";

/** Surface authentication owns identity resolution; the Workspace gate rechecks membership and policy. */
export function workspaceCaller(origin: RunOrigin) {
  const ownerEmail = mcpUserEmail(origin.actor, origin.userEmail);
  return origin.actor && ownerEmail ? { ownerEmail, actor: origin.actor,
    ...(origin.executionGrant ? { executionGrant: origin.executionGrant } : {}) } : undefined;
}
