/**
 * What wraps every top-level run, in one place.
 *
 * Four functions admit a top-level run — `executeVersion`,
 * `executeVersionStream`, `executeAgent` and `generateImage` — and each one used
 * to open and close the in-flight metric for itself. That was already the seam
 * every cross-cutting run policy wants, so it is now a named one: a policy added
 * here reaches all four, and a fifth entry point that forgets to open a bracket
 * is missing its metric as loudly as it is missing its guard.
 *
 * The image path is why this is not simply "the execution facade": `generateImage`
 * lives in its own module and is called directly by the predict route and the A2A
 * executor, never through `runProject`.
 *
 * Order matters at both ends. The guard runs *before* the metric opens, so a
 * refused run is never counted as one that ran. `close()` runs *after* the
 * caller has flushed its usage, so the settle step sees the spend of the run it
 * is settling — an agent run buffers usage until the end, and a settle before
 * the flush would always be reading the previous run's total.
 */

import type { Project } from "@/domain/project/types";
import { beginRun, endRun } from "@/lib/runMetrics";
import { assertWithinCostLimit, settleCostLimit, type CostGuardDeps } from "@/application/usage/costGuard";

export type RunBracketDeps = CostGuardDeps;

export interface RunBracket {
  /** Ends the run. Call in a `finally`, after any usage flush. Never throws. */
  close(): Promise<void>;
}

/**
 * Admit a top-level run, or refuse it.
 *
 * Throws {@link CostLimitExceededError} when the project is over its daily
 * block threshold; nothing has been counted or recorded at that point.
 */
export async function openRun(deps: RunBracketDeps, project: Project): Promise<RunBracket> {
  await assertWithinCostLimit(deps, project);
  beginRun();
  let closed = false;
  return {
    async close() {
      // Idempotent: a generator can reach its `finally` through both a normal
      // return and a consumer's `return()`, and a double decrement would leave
      // the gauge permanently understating load.
      if (closed) {
        return;
      }
      closed = true;
      endRun();
      await settleCostLimit(deps, project);
    },
  };
}
