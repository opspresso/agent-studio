import type { AgentRepository } from "@/domain/agent/repository";
import type { MessagingExecutionGrant } from "@/domain/execution/actor";
import type { MessagingIdentityUseCases } from "./messagingIdentityUseCases";
import { ValidationError } from "@/application/errors";

export interface MessagingAuthorizationDeps {
  agents: AgentRepository;
  messagingIdentities: Pick<MessagingIdentityUseCases, "resolve">;
}

/** Recheck the same linked Studio user before tools and queued work, including after a transfer. */
export async function assertMessagingExecutionGrant(deps: MessagingAuthorizationDeps, grant: MessagingExecutionGrant): Promise<void> {
  const [agent, user] = await Promise.all([
    deps.agents.get(grant.agentName),
    deps.messagingIdentities.resolve({ agentName: grant.agentName, platform: grant.kind, realm: grant.realm, externalId: grant.externalId }),
  ]);
  if (!agent || agent.name !== grant.agentName || !agent[grant.kind]?.enabled || !user || user.userId !== grant.userId || user.email !== grant.email) {
    throw new ValidationError("The messaging caller is no longer authorized");
  }
}
