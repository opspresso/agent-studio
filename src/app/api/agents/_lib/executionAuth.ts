import { tierMayRunAgents } from "@/domain/member/tiers";
import { ForbiddenError } from "@/application/errors";
import type { RunActor, RunCaller, RunUser, ApiExecutionGrant } from "@/domain/execution/actor";
import { sessionCaller } from "@/app/api/_lib/caller";
import { unauthorized } from "@/shared/unauthorized";
import { crossOriginForbidden, getSessionUser, isSameOriginMutation } from "@/lib/session";
import { apiError } from "@/app/api/_lib/http";
import { apiTokenUseCases, agentUseCases } from "@/lib/container";

interface ExecutionPrincipalBase {
  userId: string;
  email: string;
  /**
   * Who is asking, in words, when a person is. Absent for a token: it acts on
   * the issuing user's behalf but nobody is at the other end, so naming them in the
   * prompt would tell the model someone is present who is not.
   */
  caller?: RunCaller;
}
export type ExecutionPrincipal = ExecutionPrincipalBase & (
  | { viaToken: false }
  | { viaToken: true; credentialId: string }
);

/**
 * The principal as a run actor.
 *
 * A personal token authenticates as its issuing user, so both kinds carry the same email —
 * the kind is the only thing that keeps a machine's spend apart from that
 * person's own console runs, which is exactly the distinction an owner looking
 * at an unexpected bill needs.
 */
export function principalActor(principal: ExecutionPrincipal): RunActor {
  return { kind: principal.viaToken ? "agent-token" : "user", id: principal.email };
}

export interface AuthenticatedRunContext {
  user: RunUser;
  actor: RunActor;
  ownerEmail: string;
  caller?: RunCaller;
  executionGrant?: ApiExecutionGrant;
}

/** One trusted identity projection for every public Agent execution endpoint. */
export function principalRunContext(principal: ExecutionPrincipal, agentName: string): AuthenticatedRunContext {
  const user = { userId: principal.userId, email: principal.email };
  return {
    user, actor: principalActor(principal), ownerEmail: principal.email,
    ...(principal.caller ? { caller: principal.caller } : {}),
    ...(principal.viaToken ? { executionGrant: { ...user, kind: "agent-token" as const, agentName, credentialId: principal.credentialId } } : {}),
  };
}

/**
 * Authenticate an execution request scoped to `agentName`.
 * - `Authorization: Bearer <token>` verifies against the issuing user's personal token
 *   (the token acts only with that user's current Agent access).
 * - With no Authorization header, use the authenticated console session cookie.
 * Returns the acting principal, or a 401/403 `Response` to return directly.
 */
export async function authenticateExecution(
  request: Request,
  agentName: string,
): Promise<ExecutionPrincipal | Response> {
  const header = request.headers.get("authorization");
  const bearer = header ? /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() : undefined;
  if (header !== null && !bearer) return unauthorized();
  if (bearer) {
    try {
      const principal = await apiTokenUseCases.verify(agentName, bearer);
      if (!principal) return unauthorized();
      return { ...principal, viaToken: true };
    } catch (error) {
      return apiError(error);
    }
  }
  const user = await getSessionUser();
  if (!user) {
    return unauthorized();
  }
  if (!(await isSameOriginMutation(request))) {
    return crossOriginForbidden();
  }
  try {
    if (!tierMayRunAgents(user.tier)) throw new ForbiddenError("Agent execution requires member access");
    // Token invocation applies the same current Agent access gate inside the use case.
    await agentUseCases.assertAccessible(agentName, user.email);
  } catch (error) {
    return apiError(error);
  }
  const caller = sessionCaller(user);
  return { userId: user.id, email: user.email, viaToken: false, ...(caller ? { caller } : {}) };
}
