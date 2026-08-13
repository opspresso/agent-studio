import type { RunActor, RunCaller } from "@/domain/execution/actor";
import { tierMayUseApiTokens } from "@/domain/member/tiers";
import { sessionCaller } from "@/app/api/_lib/caller";
import { unauthorized } from "@/shared/unauthorized";
import { getMemberTier } from "@/lib/memberAccess";
import { getSessionUser } from "@/lib/session";
import { apiTokenUseCases } from "@/lib/container";

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
 * Returns the acting principal, or a 401/403 `Response` to return directly.
 */
export async function authenticateExecution(
  request: Request,
  projectName: string,
): Promise<ExecutionPrincipal | Response> {
  const header = request.headers.get("authorization");
  const bearer = header ? /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() : undefined;
  if (bearer) {
    const email = await apiTokenUseCases.verify(projectName, bearer);
    if (!email) {
      return unauthorized();
    }
    // The owner's *current* tier decides whether a token may authenticate at
    // all — issuance is gated too, but a later tier change must not leave a
    // working bypass behind. This is the load-bearing half of "token spend is
    // not personal spend": the budget exclusion is safe only because a tier
    // without token rights cannot present one. A 403 with the reason, not a
    // 401 — the credential is valid; the policy refuses it. Fails open on an
    // unknown tier (`null`): the lookup failing must not take every token
    // down with it.
    const ownerTier = await getMemberTier(email);
    if (ownerTier && !tierMayUseApiTokens(ownerTier)) {
      return Response.json(
        { error: "The project owner's tier does not allow API tokens" },
        { status: 403 },
      );
    }
    return { email, viaToken: true };
  }
  const user = await getSessionUser();
  if (!user) {
    return unauthorized();
  }
  const caller = sessionCaller(user);
  return { email: user.email, viaToken: false, ...(caller ? { caller } : {}) };
}
