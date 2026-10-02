import type { RunIdentity } from "@/domain/execution/actor";
import { assertRunIdentity } from "@/application/auth/authorizeRunIdentity";
import { ForbiddenError } from "@/application/errors";

/** Every effect rechecks the captured caller against the current target Agent. */
export function executionAuthorization(
  deps: { authorizeRun: (agentName: string, identity: RunIdentity) => Promise<void> },
  agentName: string, identity: RunIdentity,
): () => Promise<void> {
  return async () => {
    assertRunIdentity(identity);
    if (!deps.authorizeRun) throw new ForbiddenError("Execution permission validation is not configured");
    await deps.authorizeRun(agentName, identity);
  };
}
