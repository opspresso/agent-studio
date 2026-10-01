import type { AgentRepository } from "@/domain/agent/repository";
import type { ApiTokenRepository } from "@/domain/auth/apiToken";
import type { MemberRepository } from "@/domain/member/repository";
import { tierMayUseApiTokens } from "@/domain/member/tiers";
import type { SecretCipher } from "@/domain/security/secretCipher";
import { agentApiTokenContext } from "@/domain/security/secretContext";
import { ConflictError, ForbiddenError, NotFoundError, isConditionalWriteFailure } from "@/application/errors";
import { generateSecretValue, secretPrefix } from "@/shared/generatedSecret";
import { assertAgentAccessible, userMayAccessAgent } from "./agentUseCases";
import { auditTarget, recordAudit } from "@/application/audit/recordAudit";

export interface ApiTokenStatus {
  configured: boolean;
  canIssue: boolean;
  masked?: string;
  createdAt?: string;
}
export interface ApiTokenPrincipal { userId: string; email: string }
interface ApiTokenDeps {
  agents: AgentRepository;
  tokens: ApiTokenRepository;
  members: Pick<MemberRepository, "getById">;
  cipher: SecretCipher;
  now(): Date;
  newId(): string;
}

/** The public selector addresses one credential; the random secret is verified in constant time. */
function selector(token: string): string | undefined {
  const prefix = secretPrefix("agentApiToken");
  if (!token.startsWith(prefix)) return undefined;
  return /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.[A-Za-z0-9_-]{43}$/.exec(token.slice(prefix.length))?.[1];
}

export function createApiTokenUseCases(deps: ApiTokenDeps) {
  async function account(userId: string) {
    const member = await deps.members.getById(userId);
    if (!member || member.id !== userId) throw new ForbiddenError("An active authenticated user is required");
    return member;
  }
  async function user(agentName: string, userId: string) {
    const member = await account(userId);
    await assertAgentAccessible(deps.agents, agentName, member.email);
    return member;
  }
  async function mutation(agentName: string, userId: string) {
    const member = await user(agentName, userId);
    if (!tierMayUseApiTokens(member.tier)) throw new ForbiddenError("Your account tier does not allow API tokens");
    return member;
  }
  async function conflict(work: () => Promise<void>) {
    try { await work(); } catch (error) {
      if (isConditionalWriteFailure(error, { includeTransaction: true })) throw new ConflictError("The Agent or personal API token changed. Reload before retrying");
      throw error;
    }
  }
  return {
    async generate(agentName: string, userId: string) {
      const member = await mutation(agentName, userId);
      const previous = await deps.tokens.forUser(agentName, userId);
      const id = deps.newId();
      const prefix = secretPrefix("agentApiToken");
      const value = `${prefix}${id}.${generateSecretValue("agentApiToken").slice(prefix.length)}`;
      if (selector(value) !== id) throw new Error("Invalid API token selector");
      const masked = deps.cipher.mask(value);
      const createdAt = deps.now().toISOString();
      await conflict(() => deps.tokens.replace({ id, agentName, userId, token: deps.cipher.encrypt(value, agentApiTokenContext(agentName, userId, id)), masked, createdAt }, previous?.id ?? null));
      await recordAudit({ actorEmail: member.email, action: "secret.rotate", target: auditTarget("agent", agentName), detail: "Personal API token issued; only this user's previous token was revoked" }, deps.now());
      return { token: value, masked, createdAt };
    },
    async status(agentName: string, userId: string): Promise<ApiTokenStatus> {
      const member = await user(agentName, userId);
      const token = await deps.tokens.forUser(agentName, userId);
      return { configured: !!token, canIssue: tierMayUseApiTokens(member.tier), ...(token ? { masked: token.masked, createdAt: token.createdAt } : {}) };
    },
    async reveal(agentName: string, userId: string) {
      const member = await mutation(agentName, userId);
      const reference = await deps.tokens.forUser(agentName, userId);
      if (!reference) throw new NotFoundError("Personal API token not found");
      const token = await deps.tokens.get(agentName, reference.id);
      if (!token || token.userId !== userId) throw new ConflictError("The personal API token changed. Reload before revealing it");
      await recordAudit({ actorEmail: member.email, action: "secret.reveal", target: auditTarget("agent", agentName), detail: "Own personal API token revealed" }, deps.now());
      return { token: deps.cipher.decrypt(token.token, agentApiTokenContext(agentName, userId, token.id)), createdAt: token.createdAt };
    },
    async revoke(agentName: string, userId: string) {
      const member = await account(userId);
      const token = await deps.tokens.forUser(agentName, userId);
      if (!token) return;
      await conflict(() => deps.tokens.revoke(agentName, userId, token.id));
      await recordAudit({ actorEmail: member.email, action: "secret.revoke", target: auditTarget("agent", agentName), detail: "Own personal API token revoked" }, deps.now());
    },
    async verify(agentName: string, value: string): Promise<ApiTokenPrincipal | null> {
      const id = selector(value);
      if (!id) return null;
      const token = await deps.tokens.get(agentName, id);
      if (!token || token.agentName !== agentName || token.id !== id) return null;
      if (!deps.cipher.decryptEquals(token.token, value, agentApiTokenContext(agentName, token.userId, id))) return null;
      const member = await deps.members.getById(token.userId);
      const agent = await deps.agents.get(agentName);
      if (!agent || !member || member.id !== token.userId) return null;
      if (!tierMayUseApiTokens(member.tier)) throw new ForbiddenError("Your account tier does not allow API tokens");
      if (!await userMayAccessAgent(agent, member.email)) throw new ForbiddenError("Your account no longer has access to this Agent");
      return { userId: member.id, email: member.email };
    },
  };
}
export type ApiTokenUseCases = ReturnType<typeof createApiTokenUseCases>;
