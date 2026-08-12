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
 * refused run is never counted as one that ran. The model policy runs before
 * both, being the one refusal that costs nothing to decide and says the version
 * is misconfigured rather than that the platform is busy. Concurrency is taken
 * after cost:
 * a project that is over budget should be told so rather than made to queue for
 * a slot it will be refused on anyway. `close()` runs *after* the caller has
 * flushed its usage, so the settle step sees the spend of the run it is
 * settling — an agent run buffers usage until the end, and a settle before the
 * flush would always be reading the previous run's total.
 */

import type { RunActor } from "@/domain/execution/actor";
import type { Project, Version } from "@/domain/project/types";
import { beginRun, endRun } from "@/lib/runMetrics";
import { enterRunContext } from "@/shared/runContext";
import { assertWithinCostLimit, settleCostLimit, type CostGuardDeps } from "@/application/usage/costGuard";
import { createArtifactRecorder, type ArtifactRecorder } from "@/application/artifact/runArtifacts";
import type { ArtifactStorage } from "@/application/artifact/storeArtifact";
import { acquireRunSlot, type ConcurrencyGuardDeps } from "./concurrencyGuard";
import { assertModelsPriceable, type UnknownModelPolicy } from "./modelPolicy";
import { log } from "@/shared/logger";

export type RunBracketDeps = CostGuardDeps &
  ConcurrencyGuardDeps & {
    /**
     * Whether an unregistered model may run. Injected rather than read, like
     * every other runtime setting an application module needs — the resolution
     * order lives in `src/lib/runtime-settings.ts`, which this layer may not
     * import. Absent means `allow`, so a deps bag assembled before this existed
     * behaves exactly as it did.
     */
    unknownModelPolicy?: () => Promise<UnknownModelPolicy>;
    /**
     * Where a run's output is kept. Absent in a deployment with no object
     * storage, and then a run behaves exactly as it did — the bytes reach the
     * surface and stop there.
     */
    artifacts?: ArtifactStorage;
  };

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
  /**
   * Where this run's output goes, with the run's own identity already bound —
   * project, version, actor, transfer chain, correlation id.
   *
   * It is built here for the same reason the guards are: four entry points admit
   * a top-level run, and every one of them produces bytes. Binding the context
   * at each of them instead would be four places re-deriving who a run belongs
   * to, which is exactly the copy the attribution types exist to prevent.
   */
  readonly artifacts?: ArtifactRecorder;
}

/**
 * Admit a top-level run, or refuse it.
 *
 * Throws `ValidationError` when the version names a model this deployment
 * refuses to price, `CostLimitExceededError` when the project is over its daily
 * block threshold, or `ConcurrencyLimitError` when the caller already has every
 * slot in flight. The last two are 429s carrying `Retry-After`; nothing has been
 * counted or recorded when any of them is thrown.
 *
 * The version is a required argument rather than an optional one on purpose: a
 * fifth entry point that has to supply it cannot quietly opt out of the policies
 * that read it.
 */
export async function openRun(
  deps: RunBracketDeps,
  project: Project,
  version: Version,
  actor?: RunActor,
): Promise<RunBracket> {
  // Before the first `await`, and therefore before this function leaves the
  // caller's async context. `enterWith` binds the store to the context it runs
  // in; called after an await it would bind to this function's own continuation
  // and never reach the caller — which is exactly what happened, and it looked
  // fine in a unit test that entered the store itself.
  //
  // The cost is that a refused run also mints an id. That is the better trade:
  // the refusal's own log line is correlated too.
  const context = enterRunContext();
  // First, because it is the only refusal here that says the *configuration* is
  // wrong rather than that the platform is busy. Costing nothing to check, it
  // should not be reached by way of a queue for a slot the run would be refused
  // on regardless.
  if (deps.unknownModelPolicy) {
    // Fail open on the *read*, exactly like the cost guard below — and for the
    // reason it states: the guard exists to bound something, not to be a second
    // way for a storage blip to take the platform down. This read is a DynamoDB
    // settings lookup, so an unguarded rejection would have failed the run with
    // a raw 500 while the guard one line down was deliberately allowing runs
    // through the same outage.
    //
    // "allow" is the fallback because it is the default the policy resolves to
    // when nothing is configured; refusing every run over a lost read would be
    // strictly worse than the mispriced usage row the policy exists to prevent.
    let policy: UnknownModelPolicy = "allow";
    try {
      policy = await deps.unknownModelPolicy();
    } catch (error) {
      log.error("cost-guard", "could not read the unknown-model policy; allowing the run", error);
    }
    assertModelsPriceable(policy, {
      model: version.model,
      ...(version.fallbackModel ? { fallbackModel: version.fallbackModel } : {}),
    });
  }
  await assertWithinCostLimit(deps, project);
  const slot = await acquireRunSlot(deps, actor);
  const startedAt = Date.now();
  beginRun();
  let closed = false;
  return {
    runId: context.runId,
    ...(deps.artifacts
      ? {
          artifacts: createArtifactRecorder(deps.artifacts, {
            projectName: project.name,
            versionName: version.versionName,
            ...(actor ? { actor } : {}),
            ancestry: [project.name],
            runId: context.runId,
          }),
        }
      : {}),
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
