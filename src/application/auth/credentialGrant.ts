import type { ApiExecutionGrant, WebhookExecutionGrant } from "@/domain/execution/actor";
import type { AgentCredentialUseCases } from "./agentCredentialUseCases";
import { ForbiddenError } from "@/application/errors";

/** Revalidate only the credential and user captured by the authenticated ingress. */
export async function assertCredentialGrant(
  credentials: Pick<AgentCredentialUseCases, "authorize">,
  grant: ApiExecutionGrant | WebhookExecutionGrant,
): Promise<void> {
  const user = await credentials.authorize(grant.agentName, grant.credentialId, grant.userId);
  if (!user || user.userId !== grant.userId || user.email !== grant.email || user.credentialId !== grant.credentialId) {
    throw new ForbiddenError("The personal Agent credential is no longer authorized");
  }
}
