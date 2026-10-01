import type { Agent } from "@/domain/agent/types";
import type { AgentRepository } from "@/domain/agent/repository";
import type { MessagingExecutionGrant, RunActor } from "@/domain/execution/actor";
import { tierMayEdit, type MemberTier } from "@/domain/member/tiers";
import { ForbiddenError, ValidationError } from "@/application/errors";

export function messagingExecutionEmail(agent: Agent, kind: MessagingExecutionGrant["kind"], runAsOwner: boolean | undefined, email: string) {
  if (runAsOwner && agent.ownerEmail !== email) throw new ForbiddenError("Only the owner can enable execution with their permissions");
  return runAsOwner === undefined ? agent[kind]?.executionEmail : runAsOwner ? email : undefined;
}

export function messagingExecutionGrant(agent: Agent, actor?: RunActor): MessagingExecutionGrant | undefined {
  if (actor?.kind !== "slack" && actor?.kind !== "telegram" && actor?.kind !== "teams") return undefined;
  const email = agent[actor.kind]?.executionEmail;
  return email ? { agentName: agent.name, kind: actor.kind, email } : undefined;
}

export async function assertMessagingExecutionGrant(
  deps: { agents: AgentRepository; memberTier(email: string): Promise<MemberTier | null> }, grant: MessagingExecutionGrant,
): Promise<void> {
  const tier = await deps.memberTier(grant.email);
  const agent = await deps.agents.get(grant.agentName);
  const integration = agent?.[grant.kind];
  if ((!tier || !tierMayEdit(tier)) || agent?.ownerEmail !== grant.email ||
    !integration?.enabled || integration.executionEmail !== grant.email) {
    throw new ValidationError("The messaging execution permission is no longer authorized");
  }
}
