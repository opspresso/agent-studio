/**
 * What wraps every top-level run, in one place.
 *
 * Four functions admit a top-level run — `executeVersion`,
 * `executeVersionStream`, `executeAgent` and `generateImage` — and each one used
 * to open and close the in-flight metric for itself. That was already the seam
 * every cross-cutting run policy wants, so it is now a named one: a policy added
 * here reaches all four, and a fifth entry point that forgets to open a bracket
 * is missing its metric as loudly as it is missing its guards.
 *
 * The image path is why this is not simply "the execution facade": `generateImage`
 * lives in its own module and is called directly by the predict route and the A2A
 * executor, never through `runProject`.
 *
 * Order matters at every step. The guards run *before* the metric opens, so a
 * refused run is never counted as one that ran. Concurrency is taken after cost:
 * a project that is over budget should be told so rather than made to queue for
 * a slot it will be refused on anyway. `close()` runs *after* the caller has
 * flushed its usage, so the settle step sees the spend of the run it is
 * settling — an agent run buffers usage until the end, and a settle before the
 * flush would always be reading the previous run's total.
 */

import type { RunActor } from "@/domain/execution/actor";
import type { Project } from "@/domain/project/types";
import { beginRun, endRun } from "@/lib/runMetrics";
import { enterRunContext } from "@/shared/runContext";
import { assertWithinCostLimit, settleCostLimit, type CostGuardDeps } from "@/application/usage/costGuard";
import { acquireRunSlot, type ConcurrencyGuardDeps } from "./concurrencyGuard";

export type RunBracketDeps = CostGuardDeps & ConcurrencyGuardDeps;

export interface RunBracket {
  /**
   * Ends the run. Call in a `finally`, after any usage flush. Never throws.
   *
   * `failed` separates an error from a cancellation: a client that hung up is
   * not a failure, and counting it as one turns a page of users navigating away
   * into an outage on the dashboard.
   */
  close(outcome?: { failed?: boolean }): Promise<void>;
  /** The correlation id every log line in this run carries. */
  readonly runId: string;
}

/**
 * Admit a top-level run, or refuse it.
 *
 * Throws `CostLimitExceededError` when the project is over its daily block
 * threshold, or `ConcurrencyLimitError` when the caller already has every slot
 * in flight. Both are 429s carrying `Retry-After`, and nothing has been
 * counted or recorded when either is thrown.
 */
export async function openRun(
  deps: RunBracketDeps,
  project: Project,
  actor?: RunActor,
): Promise<RunBracket> {
  await assertWithinCostLimit(deps, project);
  const slot = await acquireRunSlot(deps, actor);
  // Opened once the run is admitted, so a refused one does not mint an id that
  // never appears again — and before the first log line the run produces.
  const context = enterRunContext();
  const startedAt = Date.now();
  beginRun();
  let closed = false;
  return {
    runId: context.runId,
    async close(outcome = {}) {
      // Idempotent: a generator can reach its `finally` through both a normal
      // return and a consumer's `return()`, and a double decrement would leave
      // the gauge permanently understating load — or release a slot a later run
      // has since taken.
      if (closed) {
        return;
      }
      closed = true;
      endRun({ durationMs: Date.now() - startedAt, ...outcome });
      await slot.release();
      await settleCostLimit(deps, project);
    },
  };
}
