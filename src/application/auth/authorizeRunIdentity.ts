import type { RunIdentity } from "@/domain/execution/actor";
import { ForbiddenError } from "@/application/errors";
import { resolveRunUser, type RunUserDeps } from "./resolveRunUser";
import { assertExecutionGrant, type ExecutionGrantDeps } from "./authorizeExecutionGrant";

export function assertRunIdentity(identity: RunIdentity): void {
  const { user, actor, executionGrant: grant } = identity;
  if (!user?.userId || !user.email || !actor?.id) throw new ForbiddenError("An authenticated Studio caller is required");
  if ((actor.kind === "user" || actor.kind === "agent-token") && actor.id !== user.email) {
    throw new ForbiddenError("Execution identity does not match its caller");
  }
  if (actor.kind === "user") {
    if (grant) throw new ForbiddenError("Interactive execution cannot adopt an automation grant");
    return;
  }
  if (!grant || grant.kind !== actor.kind || grant.userId !== user.userId || grant.email !== user.email) {
    throw new ForbiddenError("Execution identity does not match its permission grant");
  }
  const sourceId = grant.kind === "webhook" || grant.kind === "schedule"
    ? `${grant.agentName}:${grant.triggerId}`
    : grant.kind === "agent-token" ? grant.email : grant.externalId;
  if (actor.id !== sourceId) throw new ForbiddenError("Execution source does not match its permission grant");
}

/** Recheck both the original ingress authorization and access to the current target Agent. */
export async function authorizeRunIdentity(
  deps: RunUserDeps & ExecutionGrantDeps, agentName: string, identity: RunIdentity,
): Promise<void> {
  assertRunIdentity(identity);
  const current = await resolveRunUser(deps, agentName, identity.user.userId);
  if (current.email !== identity.user.email) throw new ForbiddenError("The execution account changed");
  if (identity.executionGrant) await assertExecutionGrant(deps, identity.executionGrant);
}
