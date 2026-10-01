import type { RunActor, ExecutionGrant } from "@/domain/execution/actor";
import type { AgentRepository } from "@/domain/agent/repository";
import { tierMayEdit, type MemberTier } from "@/domain/member/tiers";
import type { TriggerRepository } from "@/domain/trigger/repository";
import { assertAgentAccessible } from "@/application/agent/agentUseCases";
import { ValidationError } from "@/application/errors";
import { assertMessagingExecutionGrant } from "@/application/messaging/executionGrant";

interface WorkspaceAuthorizationDeps {
  agents: AgentRepository;
  triggers: Pick<TriggerRepository, "get">;
  memberTier(email: string): Promise<MemberTier | null>;
  backendReady(): boolean;
  enabled(agentName: string): Promise<boolean>;
}

/** Recheck the current grant, including queued work whose originating trigger may have changed. */
export async function authorizeWorkspaceExecution(
  deps: WorkspaceAuthorizationDeps, agentName: string, email: string, actor?: RunActor, grant?: ExecutionGrant,
): Promise<void> {
  const tier = await deps.memberTier(email);
  if (!tier) throw new ValidationError("Workspace tools require an active account");
  // Guest tasks must spend the authenticated user's budget. Automation grants
  // retain the member gate because their actors do not spend a personal budget.
  if (!tierMayEdit(tier) && (grant || (actor && (actor.kind !== "user" || actor.id !== email)))) {
    throw new ValidationError("Workspace automation requires member access");
  }
  await assertAgentAccessible(deps.agents, agentName, email);
  if (!deps.backendReady()) throw new ValidationError("Workspace Sandbox backend is not configured");
  if (!await deps.enabled(agentName)) throw new ValidationError("Workspace tools are disabled in the current Agent settings");
  if (grant) {
    if (grant.email !== email || grant.kind !== actor?.kind) throw new ValidationError("Workspace execution identity does not match its permission grant");
    await assertMessagingExecutionGrant(deps, grant);
  }
  if (actor?.kind !== "webhook" && actor?.kind !== "schedule") return;
  const separator = actor.id.indexOf(":");
  const sourceAgentName = actor.id.slice(0, separator);
  const triggerId = actor.id.slice(separator + 1);
  const trigger = separator > 0 ? await deps.triggers.get(sourceAgentName, triggerId) : null;
  const sourceAgent = trigger ? await deps.agents.get(sourceAgentName) : null;
  if (!trigger?.enabled || trigger.agentName !== sourceAgentName || trigger.triggerId !== triggerId ||
    trigger.kind !== actor.kind || trigger.executionEmail !== email || sourceAgent?.ownerEmail !== email) {
    throw new ValidationError("The trigger's Workspace execution permission is no longer authorized");
  }
}
