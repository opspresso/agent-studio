import type { ProjectRepository } from "@/domain/project/repository";
import { apiTokenHashEquals, generateApiTokenValue, hashApiToken } from "@/lib/apiToken";
import { assertProjectOwner, getProject } from "./projectUseCases";

export interface ApiTokenStatus {
  configured: boolean;
  createdAt?: string;
}

/**
 * Generate (or regenerate) the project's API token. Owner-only. Returns the raw
 * token once — only its hash is persisted, overwriting any previous token.
 */
export async function generateApiToken(
  repo: ProjectRepository,
  name: string,
  userEmail: string,
): Promise<{ token: string; createdAt: string }> {
  await assertProjectOwner(repo, name, userEmail);
  const token = generateApiTokenValue();
  const createdAt = new Date().toISOString();
  await repo.setApiToken(name, { tokenHash: hashApiToken(token), createdAt });
  return { token, createdAt };
}

/** Report whether the project has an API token, and when it was created. Owner-only. */
export async function getApiTokenStatus(
  repo: ProjectRepository,
  name: string,
  userEmail: string,
): Promise<ApiTokenStatus> {
  await assertProjectOwner(repo, name, userEmail);
  const token = await repo.getApiToken(name);
  return token ? { configured: true, createdAt: token.createdAt } : { configured: false };
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
  if (!apiTokenHashEquals(hashApiToken(token), stored.tokenHash)) {
    return null;
  }
  const project = await getProject(repo, name);
  return project.ownerEmail;
}
