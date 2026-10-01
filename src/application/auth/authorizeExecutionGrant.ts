import type { ExecutionGrant } from "@/domain/execution/actor";
import { assertMessagingExecutionGrant } from "@/application/auth/messagingGrant";
import { assertWebhookExecutionGrant, type WebhookAuthorizationDeps } from "@/application/auth/webhookAuthorization";

export type ExecutionGrantDeps = Parameters<typeof assertMessagingExecutionGrant>[0] & WebhookAuthorizationDeps;

export async function assertExecutionGrant(deps: ExecutionGrantDeps, grant: ExecutionGrant): Promise<void> {
  if (grant.kind === "webhook") return assertWebhookExecutionGrant(deps, grant);
  return assertMessagingExecutionGrant(deps, grant);
}
