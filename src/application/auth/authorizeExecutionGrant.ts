import type { ExecutionGrant } from "@/domain/execution/actor";
import { assertMessagingExecutionGrant } from "@/application/auth/messagingGrant";
import { assertWebhookExecutionGrant, type WebhookAuthorizationDeps } from "@/application/auth/webhookAuthorization";
import { assertCredentialGrant } from "./credentialGrant";
import type { AgentCredentialUseCases } from "./agentCredentialUseCases";
import type { RunUserDeps } from "./resolveRunUser";
import { assertScheduleExecutionGrant } from "./scheduleGrant";

export type ExecutionGrantDeps = RunUserDeps & Parameters<typeof assertMessagingExecutionGrant>[0] & WebhookAuthorizationDeps & {
  apiCredentials: Pick<AgentCredentialUseCases, "authorize">;
};

export async function assertExecutionGrant(deps: ExecutionGrantDeps, grant: ExecutionGrant): Promise<void> {
  if (grant.kind === "schedule") return assertScheduleExecutionGrant(deps, grant);
  if (grant.kind === "webhook") return assertWebhookExecutionGrant(deps, grant);
  if (grant.kind === "agent-token") return assertCredentialGrant(deps.apiCredentials, grant);
  return assertMessagingExecutionGrant(deps, grant);
}
