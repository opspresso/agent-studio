import type { RunActor, RunUser, ExecutionGrant } from "@/domain/execution/actor";
import type { AgentRepository } from "@/domain/agent/repository";
import { tierMayRunAgents, type MemberTier } from "@/domain/member/tiers";
import type { TriggerRepository } from "@/domain/trigger/repository";
import { assertAgentAccessible } from "@/application/agent/agentUseCases";
import { ValidationError } from "@/application/errors";
import type { MessagingAuthorizationDeps } from "@/application/auth/messagingGrant";
import { assertExecutionGrant, type ExecutionGrantDeps } from "@/application/auth/authorizeExecutionGrant";
import type { WebhookAuthorizationDeps } from "@/application/auth/webhookAuthorization";
import type { MemberRepository } from "@/domain/member/repository";
import { resolveRunUser } from "@/application/auth/resolveRunUser";

interface WorkspaceAuthorizationDeps extends WebhookAuthorizationDeps, MessagingAuthorizationDeps, Pick<ExecutionGrantDeps, "apiCredentials"> {
  agents: AgentRepository;
  members: Pick<MemberRepository, "getById">;
  triggers: Pick<TriggerRepository, "get">;
  memberTier(email: string): Promise<MemberTier | null>;
  backendReady(): boolean;
  enabled(agentName: string): Promise<boolean>;
}

/** Recheck the current grant, including queued work whose originating trigger may have changed. */
export async function authorizeWorkspaceExecution(
  deps: WorkspaceAuthorizationDeps, agentName: string, email: string, actor?: RunActor, grant?: ExecutionGrant, user?: RunUser,
): Promise<void> {
  if (user) {
    if (!actor) throw new ValidationError("Workspace execution requires its captured caller");
    const current = await resolveRunUser(deps, agentName, user.userId);
    if (current.email !== email || user.email !== email || (grant && grant.userId !== user.userId)) {
      throw new ValidationError("Workspace execution identity has changed");
    }
  }
  if ((actor?.kind === "user" || actor?.kind === "agent-token") && actor.id !== email) {
    throw new ValidationError("Workspace execution identity has changed");
  }
  const tier = await deps.memberTier(email);
  if (!tier) throw new ValidationError("Workspace tools require an active account");
  if (!tierMayRunAgents(tier)) {
    throw new ValidationError("Workspace execution requires member access");
  }
  await assertAgentAccessible(deps.agents, agentName, email);
  if (!deps.backendReady()) throw new ValidationError("Workspace Sandbox backend is not configured");
  if (!await deps.enabled(agentName)) throw new ValidationError("Workspace tools are disabled in the current Agent settings");
  if (grant) {
    if (grant.email !== email || grant.kind !== actor?.kind) throw new ValidationError("Workspace execution identity does not match its permission grant");
    await assertExecutionGrant(deps, grant);
  }
  if (actor?.kind === "agent-token") {
    if (grant?.kind !== "agent-token") throw new ValidationError("Workspace execution requires the authenticated personal API credential");
    return;
  }
  if (actor?.kind === "webhook") {
    if (grant?.kind !== "webhook") throw new ValidationError("Workspace execution requires the authenticated personal Webhook credential");
    return;
  }
  if (actor?.kind !== "schedule") return;
  const separator = actor.id.indexOf(":");
  const sourceAgentName = actor.id.slice(0, separator);
  const triggerId = actor.id.slice(separator + 1);
  const trigger = separator > 0 ? await deps.triggers.get(sourceAgentName, triggerId) : null;
  if (!trigger?.enabled || trigger.agentName !== sourceAgentName || trigger.triggerId !== triggerId ||
    trigger.kind !== actor.kind) {
    throw new ValidationError("The trigger's Workspace execution permission is no longer authorized");
  }
  if (trigger.kind === "schedule") {
    const registrar = await resolveRunUser(deps, sourceAgentName, trigger.createdBy.userId);
    if (registrar.email !== email || (user && registrar.userId !== user.userId)) throw new ValidationError("The schedule's Workspace execution identity has changed");
  }
}
