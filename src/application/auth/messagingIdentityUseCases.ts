import { createHash } from "node:crypto";
import type { MessagingIdentityRepository, MessagingPlatform, MessagingSubject } from "@/domain/messaging/identity";
import { MESSAGING_PLATFORMS } from "@/domain/messaging/identity";
import type { AgentRepository } from "@/domain/agent/repository";
import type { MemberRepository } from "@/domain/member/repository";
import { tierMayEdit } from "@/domain/member/tiers";
import { generateSecretValue, secretPrefix } from "@/shared/generatedSecret";
import { assertAgentAccessible } from "@/application/agent/agentUseCases";
import { ConflictError, ForbiddenError, ValidationError, isConditionalWriteFailure } from "@/application/errors";

const CODE_LIFETIME_SECONDS = 600;
const MAX_CONNECTIONS_PER_READ = 100;
const codeHash = (value: string) => createHash("sha256").update(value).digest("hex");

interface IdentityDeps { identities: MessagingIdentityRepository; members: Pick<MemberRepository, "getById">; agents: AgentRepository; now(): Date }
function validateSubject(subject: MessagingSubject) {
  if (!MESSAGING_PLATFORMS.includes(subject.platform) || !subject.agentName || !subject.realm || !subject.externalId ||
    [subject.agentName, subject.realm, subject.externalId].some(value => value.length > 256 || /[\x00-\x1f\x7f]/.test(value))) throw new ValidationError("A verified messaging platform subject is required");
}
export function createMessagingIdentityUseCases(deps: IdentityDeps) {
  async function member(userId: string) {
    const current = await deps.members.getById(userId);
    if (!current || current.id !== userId) throw new ForbiddenError("An active authenticated Studio user is required");
    return current;
  }
  async function executionUser(userId: string, agentName: string) {
    const current = await member(userId);
    if (!tierMayEdit(current.tier)) throw new ForbiddenError("Messaging authentication requires member access");
    await assertAgentAccessible(deps.agents, agentName, current.email);
    return { userId: current.id, email: current.email };
  }
  return {
    async issue(agentName: string, platform: MessagingPlatform, userId: string) {
      if (!MESSAGING_PLATFORMS.includes(platform)) throw new ValidationError("Unsupported messaging platform");
      await executionUser(userId, agentName);
      const code = generateSecretValue("messagingLinkCode");
      const expiresAt = Math.floor(deps.now().getTime() / 1000) + CODE_LIFETIME_SECONDS;
      await deps.identities.issue({ hash: codeHash(code), agentName, platform, userId, expiresAt });
      return { code, expiresAt: new Date(expiresAt * 1000).toISOString() };
    },
    async connect(subject: MessagingSubject, value: string) {
      validateSubject(subject);
      const prefix = secretPrefix("messagingLinkCode");
      if (!value.startsWith(prefix) || !/^[A-Za-z0-9_-]{43}$/.test(value.slice(prefix.length))) throw new ValidationError("Invalid messaging authentication code");
      const now = Math.floor(deps.now().getTime() / 1000);
      const code = await deps.identities.code(subject.agentName, codeHash(value), now);
      if (!code || code.agentName !== subject.agentName || code.platform !== subject.platform) throw new ValidationError("Messaging authentication code is expired, consumed or for another Agent/platform");
      const user = await executionUser(code.userId, subject.agentName);
      try { await deps.identities.bind(code, { ...subject, userId: user.userId, linkedAt: deps.now().toISOString() }, now); }
      catch (error) {
        if (isConditionalWriteFailure(error, { includeTransaction: true })) throw new ConflictError("The messaging account is already linked to another user or the code was consumed");
        throw error;
      }
      return user;
    },
    async resolve(subject: MessagingSubject) {
      validateSubject(subject);
      const linked = await deps.identities.get(subject);
      return linked ? executionUser(linked.userId, subject.agentName) : null;
    },
    async list(userId: string) { await member(userId); return deps.identities.list(userId, MAX_CONNECTIONS_PER_READ); },
    async unlink(subject: MessagingSubject, userId: string) {
      validateSubject(subject); await member(userId);
      const linked = await deps.identities.get(subject);
      if (!linked || linked.userId !== userId) throw new ForbiddenError("Only the linked Studio user can disconnect this messaging account");
      await deps.identities.unlink(linked);
    },
  };
}
export type MessagingIdentityUseCases = ReturnType<typeof createMessagingIdentityUseCases>;
