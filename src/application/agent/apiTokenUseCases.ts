import type { AgentRepository } from "@/domain/agent/repository";
import {
  DEFAULT_MEMBER_TIER,
  tierMayUseApiTokens,
  type MemberTier,
} from "@/domain/member/tiers";
import { ForbiddenError, NotFoundError, ValidationError } from "@/application/errors";
import { generateSecretValue, hashSecret, secretHashEquals } from "@/shared/generatedSecret";
import type { SecretCipher } from "@/domain/security/secretCipher";
import { assertAgentOwnerOrAdminReadable, assertAgentWritable, getAgent } from "./agentUseCases";
import { log } from "@/shared/logger";
import { auditTarget, recordAudit } from "@/application/audit/recordAudit";
import { agentApiTokenContext } from "@/domain/security/secretContext";

/**
 * How this slice learns a member's tier — injected by the composition root,
 * like the admin check in `agentUseCases`. `null` means no member row and is
 * treated as the default tier; storage failures reject instead.
 */
export type MemberTierLookup = (email: string) => Promise<MemberTier | null>;

export interface ApiTokenStatus {
  configured: boolean;
  /** Display mask of the current token, when one was recorded at generation. */
  masked?: string;
  createdAt?: string;
  /** False for a legacy hashed token, which can only be replaced. */
  revealable?: boolean;
}

/**
 * Generate (or regenerate) the agent's API token. Owner or admin. Returns the raw
 * token and stores it encrypted, so the owner can read it back later.
 *
 * The mask is stored alongside it so listing a token costs no decryption, and so
 * a legacy hashed token can still be identified.
 */
export async function generateApiToken(
  repo: AgentRepository,
  name: string,
  userEmail: string,
  cipher: SecretCipher,
  memberTier?: MemberTierLookup,
): Promise<{ token: string; masked: string; createdAt: string }> {
  const agent = await assertAgentWritable(repo, name, userEmail);
  if (memberTier) {
    // Owner-scoped, not caller-scoped: the token would authenticate as the
    // owner, so the owner's tier decides whether the credential may exist —
    // an admin minting one for a guest-owned agent would mint a token the
    // execution gate refuses anyway.
    const ownerTier = (await memberTier(agent.ownerEmail)) ?? DEFAULT_MEMBER_TIER;
    if (!tierMayUseApiTokens(ownerTier)) {
      throw new ForbiddenError(
        `The agent owner's tier ("${ownerTier}") does not allow API tokens`,
      );
    }
  }
  const token = generateSecretValue("agentApiToken");
  const masked = cipher.mask(token);
  const createdAt = new Date().toISOString();
  await repo.setApiToken(name, {
    token: cipher.encrypt(token, agentApiTokenContext(name)),
    masked,
    createdAt,
  });
  await recordAudit({
    actorEmail: userEmail,
    action: "secret.rotate",
    target: auditTarget("agent", name),
    detail: "API token issued; any previous one stopped working",
  });
  return { token, masked, createdAt };
}

/** Report whether the agent has an API token, and when it was created. Owner or admin. */
export async function getApiTokenStatus(
  repo: AgentRepository,
  name: string,
  userEmail: string,
): Promise<ApiTokenStatus> {
  await assertAgentOwnerOrAdminReadable(repo, name, userEmail);
  const token = await repo.getApiToken(name);
  if (!token) {
    return { configured: false };
  }
  return {
    configured: true,
    ...(token.masked ? { masked: token.masked } : {}),
    createdAt: token.createdAt,
    revealable: token.token !== undefined,
  };
}

/**
 * Return the agent's API token in plaintext. Owner or admin, and deliberately
 * a separate call from the status read: the token never rides along with a routine
 * page load, only with an explicit request to see it.
 *
 * This token authenticates *as the owner*, so an admin reveal is an admin taking
 * a credential that acts in someone else's name. It stays allowed — an admin can
 * regenerate the token anyway, which is strictly more disruptive — but it leaves
 * two log lines, not one: `assertAgentWritable` records the override, and the
 * line below records the reveal.
 *
 * A token issued before tokens were stored encrypted has only its hash, so there
 * is nothing to decrypt — the owner is told to regenerate rather than left with a
 * silent failure.
 */
export async function revealApiToken(
  repo: AgentRepository,
  name: string,
  userEmail: string,
  cipher: SecretCipher,
): Promise<{ token: string; createdAt: string }> {
  await assertAgentWritable(repo, name, userEmail);
  const stored = await repo.getApiToken(name);
  if (!stored) {
    throw new NotFoundError(`Agent "${name}" has no API token`);
  }
  if (stored.token === undefined) {
    throw new ValidationError(
      "This token was issued before tokens could be shown again, so only its hash is stored. Regenerate it to get a token you can read back.",
    );
  }
  // Secret access is worth a trail even when it is authorized. Both the line and
  // the row: the row is queryable, the line survives an audit-store failure.
  log.warn("token", `API token of agent '${name}' revealed by ${userEmail}`);
  await recordAudit({
    actorEmail: userEmail,
    action: "secret.reveal",
    target: auditTarget("agent", name),
    detail: "API token",
  });
  return {
    token: cipher.decrypt(stored.token, agentApiTokenContext(name)),
    createdAt: stored.createdAt,
  };
}

/** Remove the agent's API token. Owner or admin. Idempotent. */
export async function revokeApiToken(
  repo: AgentRepository,
  name: string,
  userEmail: string,
): Promise<void> {
  await assertAgentWritable(repo, name, userEmail);
  await repo.deleteApiToken(name);
  await recordAudit({
    actorEmail: userEmail,
    action: "secret.revoke",
    target: auditTarget("agent", name),
    detail: "API token",
  });
}

/**
 * Verify a raw Bearer token against the agent's stored token. On success returns
 * the agent owner's email (the token acts on the owner's behalf); on any
 * mismatch or missing token, returns null. The token is scoped to this agent.
 *
 * Both storage forms are accepted: the encrypted one is compared in constant time
 * after decryption, and a legacy hashed token keeps working by hash comparison.
 */
export async function verifyAgentApiToken(
  repo: AgentRepository,
  name: string,
  token: string,
  cipher: SecretCipher,
): Promise<string | null> {
  const stored = await repo.getApiToken(name);
  if (!stored) {
    return null;
  }
  if (!matches(cipher, stored, token, name)) {
    return null;
  }
  const agent = await getAgent(repo, name);
  return agent.ownerEmail;
}

function matches(
  cipher: SecretCipher,
  stored: { token?: string; tokenHash?: string },
  candidate: string,
  agentName: string,
): boolean {
  if (stored.token !== undefined) {
    try {
      return cipher.decryptEquals(stored.token, candidate, agentApiTokenContext(agentName));
    } catch (error) {
      // A stored token that will not decrypt (wrong or rotated AES key) is an
      // operational fault, not a wrong caller: it must be visible, and it must
      // not authenticate anyone.
      log.error(
        "token",
        `API token of agent '${agentName}' cannot be decrypted:`,
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }
  if (stored.tokenHash !== undefined) {
    return secretHashEquals(hashSecret(candidate), stored.tokenHash);
  }
  return false;
}

/**
 * The slice bound to its repository and cipher, composed once by the
 * composition root. See {@link createAgentUseCases} for why both forms exist.
 *
 * `verify` is deliberately part of it: `executionAuth.ts` is the one place a
 * raw Bearer token is checked, and it reached for both the repository and the
 * cipher to do it. That is the composition root's pairing, not a route's — a
 * surface that could pass a different cipher could verify against something the
 * token was never encrypted with.
 */
export interface ApiTokenUseCases {
  generate(name: string, userEmail: string): Promise<{ token: string; masked: string; createdAt: string }>;
  status(name: string, userEmail: string): Promise<ApiTokenStatus>;
  reveal(name: string, userEmail: string): Promise<{ token: string; createdAt: string }>;
  revoke(name: string, userEmail: string): Promise<void>;
  /** The owner's email on a match, `null` on any mismatch or missing token. */
  verify(name: string, token: string): Promise<string | null>;
}

export function createApiTokenUseCases(
  agents: AgentRepository,
  cipher: SecretCipher,
  memberTier?: MemberTierLookup,
): ApiTokenUseCases {
  return {
    generate: (name, userEmail) => generateApiToken(agents, name, userEmail, cipher, memberTier),
    status: (name, userEmail) => getApiTokenStatus(agents, name, userEmail),
    reveal: (name, userEmail) => revealApiToken(agents, name, userEmail, cipher),
    revoke: (name, userEmail) => revokeApiToken(agents, name, userEmail),
    verify: (name, token) => verifyAgentApiToken(agents, name, token, cipher),
  };
}
