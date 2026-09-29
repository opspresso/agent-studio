import type { ExecutionGrant } from "@/domain/execution/actor";
import { ValidationError } from "@/application/errors";

/** Delegated effects require a live authorization callback, including after an SDK transfer. */
export function executionGrantCheck(
  deps: { authorizeExecutionGrant?: (grant: ExecutionGrant) => Promise<void> }, grant?: ExecutionGrant,
): (() => Promise<void>) | undefined {
  if (!grant) return undefined;
  return async () => {
    if (!deps.authorizeExecutionGrant) throw new ValidationError("Execution permission validation is not configured");
    await deps.authorizeExecutionGrant(grant);
  };
}
