import type { RunActor, RunCaller } from "@/domain/execution/actor";
import { sessionCaller } from "@/app/api/_lib/caller";
import { unauthorized } from "@/shared/unauthorized";
import { getSessionUser } from "@/lib/session";
import { projectRepository, secretCipher } from "@/lib/container";
import { verifyProjectApiToken } from "@/application/project/apiTokenUseCases";

export interface ExecutionPrincipal {
  email: string;
  viaToken: boolean;
  /**
   * Who is asking, in words, when a person is. Absent for a token: it acts on
   * the owner's behalf but nobody is at the other end, so naming them in the
   * prompt would tell the model someone is present who is not.
   */
  caller?: RunCaller;
}

/**
 * The principal as a run actor.
 *
 * A token authenticates *as its owner*, so both kinds carry the same email —
 * the kind is the only thing that keeps a machine's spend apart from that
 * person's own console runs, which is exactly the distinction an owner looking
 * at an unexpected bill needs.
 */
export function principalActor(principal: ExecutionPrincipal): RunActor {
  return { kind: principal.viaToken ? "project-token" : "user", id: principal.email };
}

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
  if (!user) {
    return unauthorized();
  }
  const caller = sessionCaller(user);
  return { email: user.email, viaToken: false, ...(caller ? { caller } : {}) };
}
