import type { AgentCredentialUseCases, AgentCredentialPrincipal } from "@/application/auth/agentCredentialUseCases";
import { verifyGitHubSignature } from "@/shared/githubWebhook";

export const WEBHOOK_CREDENTIAL_ID = "00000000-0000-4000-8000-000000000001";

/** Authentication boundary for firing tests; credential storage and crypto isolation have separate real-adapter tests. */
export function webhookCredentialFixture(agentName: string, secret: string, email = "caller@example.test", userId = "webhook-user", credentialId = WEBHOOK_CREDENTIAL_ID) {
  let active = true;
  const principal: AgentCredentialPrincipal = { userId, email, credentialId };
  const credentials: Pick<AgentCredentialUseCases, "verify" | "verifySignature" | "authorize"> = {
    async verify(agent, value) { return active && agent === agentName && value === secret ? { ...principal } : null; },
    async verifySignature(agent, id, body, signature) {
      return active && agent === agentName && id === principal.credentialId && verifyGitHubSignature(secret, body, signature) ? { ...principal } : null;
    },
    async authorize(agent, id, userId) {
      return active && agent === agentName && id === principal.credentialId && userId === principal.userId ? { ...principal } : null;
    },
  };
  return { credentials, principal, revoke: () => { active = false; }, enable: () => { active = true; } };
}
