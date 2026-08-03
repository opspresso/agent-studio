import type { RunActor } from "@/domain/execution/actor";
import { unauthorized } from "@/shared/unauthorized";
import { getSessionUser } from "@/lib/session";
import { machineTenant } from "@/lib/workspace";
import { withTenant } from "@/shared/tenantContext";
import { SLUG_RULE } from "@/shared/slug";
import { projectRepository, secretCipher } from "@/lib/container";
import { verifyProjectApiToken } from "@/application/project/apiTokenUseCases";

export interface ExecutionPrincipal {
  email: string;
  viaToken: boolean;
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
 * Authenticate an execution request scoped to `projectName`, and say which
 * workspace it runs in.
 *
 * - `Authorization: Bearer <token>` verifies against the project's API token
 *   (the token acts on the owner's behalf), in the tenant the request named.
 * - Otherwise falls back to the console session cookie, in the tenant that
 *   session belongs to.
 *
 * The tenant is resolved *before* the credential is checked, because the token
 * itself is a tenant-scoped row: verifying first and scoping after would look
 * the secret up in the wrong place. The caller runs the rest of the request
 * inside the returned scope.
 *
 * Returns the acting principal and tenant, or a 401 `Response` to return
 * directly.
 */
export async function authenticateExecution(
  request: Request,
  projectName: string,
): Promise<{ principal: ExecutionPrincipal; tenant: string } | Response> {
  const header = request.headers.get("authorization");
  const bearer = header ? /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() : undefined;
  if (bearer) {
    const tenant = machineTenant(request);
    if (tenant === null) {
      // Not a 401: the credential was never looked at. Saying "unauthorized"
      // here sends the caller to rotate a token that is fine.
      return Response.json({ error: `tenant ${SLUG_RULE}` }, { status: 400 });
    }
    const email = await withTenant(tenant, () =>
      verifyProjectApiToken(projectRepository, projectName, bearer, secretCipher),
    );
    return email ? { principal: { email, viaToken: true }, tenant } : unauthorized();
  }
  const user = await getSessionUser();
  return user ? { principal: { email: user.email, viaToken: false }, tenant: user.tenant } : unauthorized();
}
