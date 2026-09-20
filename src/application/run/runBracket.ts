/**
 * Common admission, accounting and artifact scope for Agent executions.
 * Model and cost policies run before acquiring a slot. Call close only after
 * usage is flushed so settlement includes this run, including delegated work.
 */

import type { RunActor } from "@/domain/execution/actor";
import type { MemberTier } from "@/domain/member/tiers";
import type { Project, AgentConfiguration } from "@/domain/project/types";
import { beginRun, endRun } from "@/lib/runMetrics";
import { enterRunContext } from "@/shared/runContext";
import { assertWithinCostLimit, settleCostLimit, type CostGuardDeps } from "@/application/usage/costGuard";
import { assertWithinMemberCostLimit } from "@/application/usage/memberCostGuard";
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
     * import. Absent explicitly means `allow` for a caller that does not supply
     * an unknown-model policy.
     */
    unknownModelPolicy?: () => Promise<UnknownModelPolicy>;
    /**
     * Where a run's output is kept. Absent in a deployment with no object
     * storage, and then a run behaves exactly as it did — the bytes reach the
     * surface and stop there.
     */
    artifacts?: ArtifactStorage;
    /**
     * The tier of the member behind this actor, or `undefined` for the kinds
     * no member backs (slack, a2a, webhook, schedule) — those keep the
     * deployment-wide limits. Injected rather than read, like every other
     * runtime lookup here; absent means no tier policy at all.
     */
    resolveActorTier?: (actor: RunActor) => Promise<MemberTier | undefined>;
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
   * project, Agent, actor, transfer chain, correlation id.
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
 * Throws `ValidationError` when the Agent names a model this deployment
 * refuses to price, `CostLimitExceededError` when the project is over its daily
 * block threshold, `MemberCostLimitExceededError` when the member behind the
 * actor has spent their tier's monthly cap, or `ConcurrencyLimitError` when the
 * caller already has every slot in flight. All but the first are 429s carrying
 * `Retry-After`; nothing has been counted or recorded when any of them is
 * thrown.
 *
 * Model entry points require Agent model settings through openModelCall/openRun. Workspace
 * tasks use openTaskRun and share the remaining guards without inventing a model.
 */
async function openExecutionBracket(
  deps: RunBracketDeps,
  project: Project,
  configuration: Pick<AgentConfiguration, "model" | "fallbackModel"> | undefined,
  actor?: RunActor,
): Promise<Omit<RunBracket, "artifacts">> {
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
  if (configuration && deps.unknownModelPolicy) {
    // Fail open on the *read*, exactly like the cost guard below — and for the
    // reason it states: the guard exists to bound something, not to be a second
    // way for a storage blip to take the platform down. This read is a database
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
      model: configuration.model,
      ...(configuration.fallbackModel ? { fallbackModel: configuration.fallbackModel } : {}),
    });
  }
  await assertWithinCostLimit(deps, project);
  // Resolved once, for both tier policies below. Fail open on the read like
  // the policy above: `undefined` degrades to the deployment-wide limits.
  let tier: MemberTier | undefined;
  if (deps.resolveActorTier && actor) {
    try {
      tier = await deps.resolveActorTier(actor);
    } catch (error) {
      log.error("cost-guard", "could not resolve the caller's tier; using the deployment limits", error);
    }
  }
  // Before the slot for the same reason cost precedes concurrency: a member
  // over budget should be told so rather than queue for a slot the run would
  // be refused on anyway.
  await assertWithinMemberCostLimit(deps, actor, tier);
  const slot = await acquireRunSlot(deps, actor, tier);
  const startedAt = Date.now();
  const runMetric = beginRun(startedAt);
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
      endRun(runMetric, { durationMs: Date.now() - startedAt, ...outcome });
      await slot.release();
      await settleCostLimit(deps, project);
    },
  };
}

export function openModelCall(
  deps: RunBracketDeps,
  project: Project,
  configuration: Pick<AgentConfiguration, "model" | "fallbackModel">,
  actor?: RunActor,
): Promise<Omit<RunBracket, "artifacts">> {
  return openExecutionBracket(deps, project, configuration, actor);
}

/** Non-model workspace jobs share cost, concurrency and metrics without inventing a model. */
export function openTaskRun(
  deps: RunBracketDeps,
  project: Project,
  actor: RunActor,
): Promise<Omit<RunBracket, "artifacts">> {
  return openExecutionBracket(deps, project, undefined, actor);
}

/** Chunk-producing runs add artifact capture to the common metered model-call bracket. */
export async function openRun(
  deps: RunBracketDeps,
  project: Project,
  configuration: AgentConfiguration,
  actor?: RunActor,
  opts: { ownerEmail?: string } = {},
): Promise<RunBracket> {
  const bracket = await openModelCall(deps, project, configuration, actor);
  return {
    ...bracket,
    ...(deps.artifacts ? { artifacts: createArtifactRecorder(deps.artifacts, {
      projectName: project.name,
      ...(actor ? { actor } : {}), ...(opts.ownerEmail ? { ownerEmail: opts.ownerEmail } : {}),
      ancestry: [project.name], runId: bracket.runId,
    }) } : {}),
  };
}
