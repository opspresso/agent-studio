import type { RunOrigin } from "@/domain/execution/actor";
import { assertRunIdentity } from "@/application/auth/authorizeRunIdentity";
import { ForbiddenError } from "@/application/errors";

/** Surface authentication owns identity resolution; never infer a Studio user from an actor email. */
export function workspaceCaller(origin: Partial<RunOrigin>) {
  try {
    assertRunIdentity(origin);
  } catch (error) {
    if (error instanceof ForbiddenError) return undefined;
    throw error;
  }
  return { user: origin.user, ownerEmail: origin.user.email, actor: origin.actor,
    ...(origin.executionGrant ? { executionGrant: origin.executionGrant } : {}) };
}
