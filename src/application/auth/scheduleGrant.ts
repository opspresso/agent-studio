import type { ScheduleExecutionGrant } from "@/domain/execution/actor";
import type { TriggerRepository } from "@/domain/trigger/repository";
import { ForbiddenError } from "@/application/errors";
import { resolveRunUser, type RunUserDeps } from "./resolveRunUser";

export async function assertScheduleExecutionGrant(
  deps: RunUserDeps & { triggers: Pick<TriggerRepository, "get"> }, grant: ScheduleExecutionGrant,
): Promise<void> {
  const trigger = await deps.triggers.get(grant.agentName, grant.triggerId);
  if (!trigger?.enabled || trigger.kind !== "schedule" || trigger.agentName !== grant.agentName ||
    trigger.triggerId !== grant.triggerId || trigger.createdBy.userId !== grant.userId || trigger.updatedAt !== grant.revision) {
    throw new ForbiddenError("The schedule's execution permission changed");
  }
  const current = await resolveRunUser(deps, grant.agentName, grant.userId, "schedule");
  if (current.email !== grant.email) throw new ForbiddenError("The schedule's execution account changed");
}
