import type { ProjectRepository } from "@/domain/project/repository";
import { NotFoundError, ValidationError } from "@/application/errors";
import { generateSecretValue, hashSecret, secretHashEquals } from "@/shared/generatedSecret";
import type { SecretCipher } from "@/domain/security/secretCipher";
import { assertProjectWritable, getProject } from "./projectUseCases";

export interface ApiTokenStatus {
  configured: boolean;
  /** Display mask of the current token, when one was recorded at generation. */
  masked?: string;
  createdAt?: string;
  /** False for a legacy hashed token, which can only be replaced. */
  revealable?: boolean;
}

/**
 * Generate (or regenerate) the project's API token. Owner or admin. Returns the raw
 * token and stores it encrypted, so the owner can read it back later.
 *
 * The mask is stored alongside it so listing a token costs no decryption, and so
 * a legacy hashed token can still be identified.
 */
export async function generateApiToken(
  repo: ProjectRepository,
  name: string,
  userEmail: string,
  cipher: SecretCipher,
): Promise<{ token: string; masked: string; createdAt: string }> {
  await assertProjectWritable(repo, name, userEmail);
  const token = generateSecretValue("projectApiToken");
  const masked = cipher.mask(token);
  const createdAt = new Date().toISOString();
  await repo.setApiToken(name, { token: cipher.encrypt(token), masked, createdAt });
  return { token, masked, createdAt };
}

/** Report whether the project has an API token, and when it was created. Owner or admin. */
export async function getApiTokenStatus(
  repo: ProjectRepository,
  name: string,
  userEmail: string,
): Promise<ApiTokenStatus> {
  await assertProjectWritable(repo, name, userEmail);
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
 * Return the project's API token in plaintext. Owner or admin, and deliberately
 * a separate call from the status read: the token never rides along with a routine
 * page load, only with an explicit request to see it.
 *
 * This token authenticates *as the owner*, so an admin reveal is an admin taking
 * a credential that acts in someone else's name. It stays allowed — an admin can
 * regenerate the token anyway, which is strictly more disruptive — but it leaves
 * two log lines, not one: `assertProjectWritable` records the override, and the
 * line below records the reveal.
 *
 * A token issued before tokens were stored encrypted has only its hash, so there
 * is nothing to decrypt — the owner is told to regenerate rather than left with a
 * silent failure.
 */
export async function revealApiToken(
  repo: ProjectRepository,
  name: string,
  userEmail: string,
  cipher: SecretCipher,
): Promise<{ token: string; createdAt: string }> {
  await assertProjectWritable(repo, name, userEmail);
  const stored = await repo.getApiToken(name);
  if (!stored) {
    throw new NotFoundError(`Project "${name}" has no API token`);
  }
  if (stored.token === undefined) {
    throw new ValidationError(
      "This token was issued before tokens could be shown again, so only its hash is stored. Regenerate it to get a token you can read back.",
    );
  }
  // Secret access is worth a trail even when it is authorized.
  console.warn(`[token] API token of project '${name}' revealed by ${userEmail}`);
  return { token: cipher.decrypt(stored.token), createdAt: stored.createdAt };
}

/** Remove the project's API token. Owner or admin. Idempotent. */
export async function revokeApiToken(
  repo: ProjectRepository,
  name: string,
  userEmail: string,
): Promise<void> {
  await assertProjectWritable(repo, name, userEmail);
  await repo.deleteApiToken(name);
}

/**
 * Verify a raw Bearer token against the project's stored token. On success returns
 * the project owner's email (the token acts on the owner's behalf); on any
 * mismatch or missing token, returns null. The token is scoped to this project.
 *
 * Both storage forms are accepted: the encrypted one is compared in constant time
 * after decryption, and a legacy hashed token keeps working by hash comparison.
 */
export async function verifyProjectApiToken(
  repo: ProjectRepository,
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
  const project = await getProject(repo, name);
  return project.ownerEmail;
}

function matches(
  cipher: SecretCipher,
  stored: { token?: string; tokenHash?: string },
  candidate: string,
  projectName: string,
): boolean {
  if (stored.token !== undefined) {
    try {
      return cipher.decryptEquals(stored.token, candidate);
    } catch (error) {
      // A stored token that will not decrypt (wrong or rotated AES key) is an
      // operational fault, not a wrong caller: it must be visible, and it must
      // not authenticate anyone.
      console.error(
        `[token] API token of project '${projectName}' cannot be decrypted:`,
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
