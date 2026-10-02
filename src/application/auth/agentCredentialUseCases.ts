import type { AgentRepository } from "@/domain/agent/repository";
import type { AgentCredential, AgentCredentialPurpose, AgentCredentialRepository } from "@/domain/auth/agentCredential";
import type { MemberRepository } from "@/domain/member/repository";
import { tierMayUseApiTokens } from "@/domain/member/tiers";
import type { SecretCipher } from "@/domain/security/secretCipher";
import { agentCredentialContext } from "@/domain/security/secretContext";
import { ConflictError, ForbiddenError, NotFoundError, isConditionalWriteFailure } from "@/application/errors";
import { generateSecretValue, secretPrefix } from "@/shared/generatedSecret";
import { assertAgentAccessible } from "@/application/agent/agentUseCases";
import { mayAccessAgent } from "@/domain/agent/access";
import { auditTarget, recordAudit } from "@/application/audit/recordAudit";
import { verifyGitHubSignature } from "@/shared/githubWebhook";

export interface AgentCredentialStatus {
  configured: boolean;
  canIssue: boolean;
  credentialId?: string;
  masked?: string;
  createdAt?: string;
}
export interface AgentCredentialPrincipal { userId: string; email: string; credentialId: string }
interface AgentCredentialDeps {
  purpose: AgentCredentialPurpose;
  agents: AgentRepository;
  tokens: AgentCredentialRepository;
  members: Pick<MemberRepository, "getById">;
  cipher: SecretCipher;
  now(): Date;
  newId(): string;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SECRET_KIND = { api: "agentApiToken", webhook: "agentWebhookToken" } as const;

/** The public selector addresses one credential; the random secret is verified in constant time. */
function selector(token: string, purpose: AgentCredentialPurpose): string | undefined {
  const prefix = secretPrefix(SECRET_KIND[purpose]);
  if (!token.startsWith(prefix)) return undefined;
  const [id, secret, extra] = token.slice(prefix.length).split(".");
  return id && UUID.test(id) && secret && /^[A-Za-z0-9_-]{43}$/.test(secret) && extra === undefined ? id : undefined;
}

export function createAgentCredentialUseCases(deps: AgentCredentialDeps) {
  const purpose = deps.purpose;
  const kind = SECRET_KIND[purpose];
  const label = purpose === "api" ? "API" : "Webhook";
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
    if (!tierMayUseApiTokens(member.tier)) throw new ForbiddenError(`Your account tier does not allow ${label} tokens`);
    return member;
  }
  async function conflict(work: () => Promise<void>) {
    try { await work(); } catch (error) {
      if (isConditionalWriteFailure(error, { includeTransaction: true })) throw new ConflictError(`The Agent or personal ${label} token changed. Reload before retrying`);
      throw error;
    }
  }
  async function principal(token: AgentCredential): Promise<AgentCredentialPrincipal | null> {
    const [member, agent] = await Promise.all([
      deps.members.getById(token.userId), deps.agents.get(token.agentName),
    ]);
    if (!agent || !member || member.id !== token.userId) return null;
    if (!tierMayUseApiTokens(member.tier)) throw new ForbiddenError(`Your account tier does not allow ${label} tokens`);
    if (!mayAccessAgent(agent, member.email)) throw new ForbiddenError("Your account no longer has access to this Agent");
    return { userId: member.id, email: member.email, credentialId: token.id };
  }
  return {
    async generate(agentName: string, userId: string) {
      const member = await mutation(agentName, userId);
      const previous = await deps.tokens.forUser(agentName, purpose, userId);
      const id = deps.newId();
      const prefix = secretPrefix(kind);
      const value = `${prefix}${id}.${generateSecretValue(kind).slice(prefix.length)}`;
      if (selector(value, purpose) !== id) throw new Error(`Invalid ${label} token selector`);
      const masked = deps.cipher.mask(value);
      const createdAt = deps.now().toISOString();
      await conflict(() => deps.tokens.replace({ id, purpose, agentName, userId, token: deps.cipher.encrypt(value, agentCredentialContext(agentName, purpose, userId, id)), masked, createdAt }, previous?.id ?? null));
      await recordAudit({ actorEmail: member.email, action: "secret.rotate", target: auditTarget("agent", agentName), detail: `Personal ${label} token issued; only this user's previous token was revoked` }, deps.now());
      return { token: value, credentialId: id, masked, createdAt };
    },
    async status(agentName: string, userId: string): Promise<AgentCredentialStatus> {
      const member = await user(agentName, userId);
      const token = await deps.tokens.forUser(agentName, purpose, userId);
      return { configured: !!token, canIssue: tierMayUseApiTokens(member.tier), ...(token ? { credentialId: token.id, masked: token.masked, createdAt: token.createdAt } : {}) };
    },
    async reveal(agentName: string, userId: string) {
      const member = await mutation(agentName, userId);
      const reference = await deps.tokens.forUser(agentName, purpose, userId);
      if (!reference) throw new NotFoundError(`Personal ${label} token not found`);
      const token = await deps.tokens.get(agentName, purpose, reference.id);
      if (!token || token.userId !== userId) throw new ConflictError(`The personal ${label} token changed. Reload before revealing it`);
      await recordAudit({ actorEmail: member.email, action: "secret.reveal", target: auditTarget("agent", agentName), detail: `Own personal ${label} token revealed` }, deps.now());
      return { token: deps.cipher.decrypt(token.token, agentCredentialContext(agentName, purpose, userId, token.id)), credentialId: token.id, createdAt: token.createdAt };
    },
    async revoke(agentName: string, userId: string) {
      const member = await account(userId);
      const token = await deps.tokens.forUser(agentName, purpose, userId);
      if (!token) return;
      await conflict(() => deps.tokens.revoke(agentName, purpose, userId, token.id));
      await recordAudit({ actorEmail: member.email, action: "secret.revoke", target: auditTarget("agent", agentName), detail: `Own personal ${label} token revoked` }, deps.now());
    },
    async verify(agentName: string, value: string): Promise<AgentCredentialPrincipal | null> {
      const id = selector(value, purpose);
      if (!id) return null;
      const token = await deps.tokens.get(agentName, purpose, id);
      if (!token || token.agentName !== agentName || token.id !== id || token.purpose !== purpose) return null;
      if (!deps.cipher.decryptEquals(token.token, value, agentCredentialContext(agentName, purpose, token.userId, id))) return null;
      return principal(token);
    },
    /** The public selector is delivered in the callback URL; the body HMAC proves possession. */
    async verifySignature(agentName: string, credentialId: string, body: string, signature: string | null): Promise<AgentCredentialPrincipal | null> {
      if (purpose !== "webhook" || !UUID.test(credentialId)) return null;
      const token = await deps.tokens.get(agentName, purpose, credentialId);
      if (!token || token.purpose !== purpose || token.agentName !== agentName || token.id !== credentialId) return null;
      const secret = deps.cipher.decrypt(token.token, agentCredentialContext(agentName, purpose, token.userId, token.id));
      return verifyGitHubSignature(secret, body, signature) ? principal(token) : null;
    },
    /** Recheck an already authenticated invocation before queued or delegated effects. */
    async authorize(agentName: string, credentialId: string, userId: string): Promise<AgentCredentialPrincipal | null> {
      if (!UUID.test(credentialId)) return null;
      const token = await deps.tokens.get(agentName, purpose, credentialId);
      return token && token.purpose === purpose && token.agentName === agentName && token.id === credentialId && token.userId === userId
        ? principal(token) : null;
    },
  };
}
export type AgentCredentialUseCases = ReturnType<typeof createAgentCredentialUseCases>;

export type IssuedAgentCredential = Awaited<ReturnType<AgentCredentialUseCases["generate"]>>;
