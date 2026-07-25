import { getSessionUser } from "@/lib/session";
import { projectRepository, secretCipher } from "@/lib/container";
import { verifyProjectApiToken } from "@/application/project/apiTokenUseCases";

export interface ExecutionPrincipal {
  email: string;
  viaToken: boolean;
}

const unauthorized = (): Response => Response.json({ error: "Unauthorized" }, { status: 401 });

/**
 * Authenticate an execution request scoped to `projectName`.
 * - `Authorization: Bearer <token>` verifies against the project's API token
 *   (the token acts on the owner's behalf).
 * - Otherwise falls back to the console session cookie.
 * Returns the acting principal, or a 401 `Response` to return directly.
 */
export async function authenticateExecution(
  request: Request,
  projectName: string,
): Promise<ExecutionPrincipal | Response> {
  const header = request.headers.get("authorization");
  const bearer = header ? /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() : undefined;
  if (bearer) {
    const email = await verifyProjectApiToken(projectRepository, projectName, bearer, secretCipher);
    return email ? { email, viaToken: true } : unauthorized();
  }
  const user = await getSessionUser();
  return user ? { email: user.email, viaToken: false } : unauthorized();
}
