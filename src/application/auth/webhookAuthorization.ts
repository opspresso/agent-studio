import type { WebhookExecutionGrant } from "@/domain/execution/actor";
import type { TriggerRepository } from "@/domain/trigger/repository";
import { AGENT_WEBHOOK_ID } from "@/domain/trigger/types";
import type { AgentCredentialUseCases } from "@/application/auth/agentCredentialUseCases";
import { ValidationError } from "@/application/errors";

export interface WebhookAuthorizationDeps {
  triggers: Pick<TriggerRepository, "get">;
  webhookCredentials: Pick<AgentCredentialUseCases, "authorize">;
}

/** A public selector is not a new authentication method; only a previously verified grant reaches this boundary. */
export async function assertWebhookExecutionGrant(deps: WebhookAuthorizationDeps, grant: WebhookExecutionGrant): Promise<void> {
  if (grant.triggerId !== AGENT_WEBHOOK_ID) throw new ValidationError("Invalid Webhook execution grant");
  const [trigger, user] = await Promise.all([
    deps.triggers.get(grant.agentName, grant.triggerId),
    deps.webhookCredentials.authorize(grant.agentName, grant.credentialId, grant.userId),
  ]);
  if (!trigger?.enabled || trigger.kind !== "webhook" || trigger.agentName !== grant.agentName || trigger.triggerId !== grant.triggerId ||
    !user || user.userId !== grant.userId || user.email !== grant.email) {
    throw new ValidationError("The Webhook caller is no longer authorized");
  }
}
