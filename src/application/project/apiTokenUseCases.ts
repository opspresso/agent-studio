import type { ProjectRepository } from "@/domain/project/repository";
import { generateSecretValue, hashSecret, secretHashEquals } from "@/lib/generatedSecret";
import { maskSecret } from "@/infrastructure/crypto/secretEncryption";
import { assertProjectOwner, getProject } from "./projectUseCases";

export interface ApiTokenStatus {
  configured: boolean;
  /** Display mask of the current token, when one was recorded at generation. */
  masked?: string;
  createdAt?: string;
}

/**
 * Generate (or regenerate) the project's API token. Owner-only. Returns the raw
 * token once — only its hash is persisted, overwriting any previous token.
 *
 * The mask is computed here and stored alongside the hash: the token cannot be
 * recovered later, so without it the console could only say "a token is set"
 * and never which one.
 */
export async function generateApiToken(
  repo: ProjectRepository,
  name: string,
  userEmail: string,
): Promise<{ token: string; masked: string; createdAt: string }> {
  await assertProjectOwner(repo, name, userEmail);
  const token = generateSecretValue("projectApiToken");
  const masked = maskSecret(token);
  const createdAt = new Date().toISOString();
  await repo.setApiToken(name, { tokenHash: hashSecret(token), masked, createdAt });
  return { token, masked, createdAt };
}

/** Report whether the project has an API token, and when it was created. Owner-only. */
export async function getApiTokenStatus(
  repo: ProjectRepository,
  name: string,
  userEmail: string,
): Promise<ApiTokenStatus> {
  await assertProjectOwner(repo, name, userEmail);
  const token = await repo.getApiToken(name);
  if (!token) {
    return { configured: false };
  }
  return {
    configured: true,
    ...(token.masked ? { masked: token.masked } : {}),
    createdAt: token.createdAt,
  };
}

/** Remove the project's API token. Owner-only. Idempotent. */
export async function revokeApiToken(
  repo: ProjectRepository,
  name: string,
  userEmail: string,
): Promise<void> {
  await assertProjectOwner(repo, name, userEmail);
  await repo.deleteApiToken(name);
}

/**
 * Verify a raw Bearer token against the project's stored hash. On success returns
 * the project owner's email (the token acts on the owner's behalf); on any
 * mismatch or missing token, returns null. The token is scoped to this project.
 */
export async function verifyProjectApiToken(
  repo: ProjectRepository,
  name: string,
  token: string,
): Promise<string | null> {
  const stored = await repo.getApiToken(name);
  if (!stored) {
    return null;
  }
  if (!secretHashEquals(hashSecret(token), stored.tokenHash)) {
    return null;
  }
  const project = await getProject(repo, name);
  return project.ownerEmail;
}
