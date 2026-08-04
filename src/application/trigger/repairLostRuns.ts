/**
 * Finish the history rows a lost instance left in `running`.
 *
 * Both trigger kinds acknowledge first and run in `after()`, so an instance
 * killed mid-firing leaves a row claiming a run is in flight when nothing is.
 * The crash policy is the same for both and is deliberately *not* re-execution:
 * a run is not idempotent — its tools have side effects — so what a repair
 * corrects is the ledger, not the work. An operator has to be able to tell
 * "still running" from "nobody is coming back", and only this can say so.
 *
 * **Two callers, because one tick is not a guarantee.** The scheduler's scan
 * sweeps every project on a gated tick, and a webhook delivery sweeps its own
 * trigger as it finishes. The second exists because the ticker is optional —
 * a deployment can serve webhooks and configure no CronJob at all — and a
 * durability fix that only runs where a scheduler happens to be pointed is not
 * one.
 *
 * **Enumeration walks projects rather than a cross-project index.** Schedule
 * rows carry one (`TYPE#SCHEDULE`) because the tick fires them every minute, so
 * listing them is that scan's hot path. Repair is not: it runs on a gated tick
 * and only to find wreckage. Granting webhook rows the same index would cover
 * only rows written after the index existed, and a webhook trigger that predates
 * this repair is precisely the one most likely to have stranded a row already —
 * a durability fix that skips the rows it was written for is the wrong shape.
 * Walking `projects.list()` reads every row that exists today, needs no
 * backfill, and costs one query per project on a repair tick only.
 */

import type { Trigger, TriggerRun } from "@/domain/trigger/types";
import { RUN_LEASE_SECONDS } from "@/shared/runDeadline";
import { log } from "@/shared/logger";
import type { FiringDeps } from "./runTrigger";

/**
 * How far past a run's lease a `running` row must sit before it is declared
 * lost. `startedAt` is stamped when the firing is *admitted*, not when the
 * backgrounded run starts, so the margin has to cover the distance between
 * those two on top of the lease itself. Repairing late is cosmetic; repairing a
 * live run brands a healthy instance as lost.
 */
export const REPAIR_MARGIN_SECONDS = 10 * 60;

/** When a row stuck in `running` is surely dead. */
export const REPAIR_AFTER_SECONDS = RUN_LEASE_SECONDS + REPAIR_MARGIN_SECONDS;

/**
 * How many history rows one trigger's pass reads.
 *
 * The window is bounded by `startedBefore`, not by recency, so this is "how many
 * rows can be stranded at once", not "how many firings happened lately". A
 * webhook trigger taking ten deliveries a minute writes hundreds of rows inside
 * one lease; reading the newest fifty of *those* would never reach the row that
 * actually needs finishing, however often the sweep ran.
 */
export const REPAIR_SCAN_LIMIT = 50;

/** What a repaired row says happened, in the place an operator will read it. */
export const LOST_RUN_ERROR =
  "The instance running this firing was lost; its lease expired without a result.";

export interface RepairSummary {
  /** Rows stuck in `running` past any live lease, finished as failed. */
  repaired: number;
  /** Repository throws fenced off from the rest of the sweep; each is logged. */
  errors: number;
}

function merge(into: RepairSummary, from: RepairSummary): void {
  into.repaired += from.repaired;
  into.errors += from.errors;
}

/**
 * Sweep every trigger of every project at instant `at`. Never throws: it runs
 * inside a tick whose other work must survive a single unreadable partition.
 */
export async function repairLostRuns(deps: FiringDeps, at: Date): Promise<RepairSummary> {
  const summary: RepairSummary = { repaired: 0, errors: 0 };
  let projectNames: string[];
  try {
    projectNames = (await deps.projects.list()).map((project) => project.name);
  } catch (error) {
    // Without the project list there is nothing to walk; the next repair tick
    // tries again, and the rows are not going anywhere.
    log.warn("trigger", "could not list projects to repair lost firings", error);
    return { repaired: 0, errors: 1 };
  }
  for (const projectName of projectNames) {
    let triggers: Trigger[];
    try {
      triggers = await deps.triggers.listByProject(projectName);
    } catch (error) {
      log.warn("trigger", `could not list triggers of '${projectName}' for repair`, error);
      summary.errors += 1;
      continue;
    }
    for (const trigger of triggers) {
      // Regardless of `enabled`: disabling a trigger must not strand the row its
      // last firing left behind.
      merge(summary, await repairTriggerRuns(deps, trigger, at));
    }
  }
  return summary;
}

/**
 * One trigger's stranded rows, fenced so a throw costs only that trigger.
 *
 * Exported because a webhook delivery sweeps its own trigger on the way out. The
 * scheduler's tick is the only *periodic* caller there is, and a deployment that
 * serves webhooks with no ticker configured — which the operations guide says is
 * a supported shape — would otherwise get none of this: its stranded rows would
 * read `running` forever, which is the one state this module exists to remove.
 */
export async function repairTriggerRuns(
  deps: FiringDeps,
  trigger: Trigger,
  at: Date,
): Promise<RepairSummary> {
  const summary: RepairSummary = { repaired: 0, errors: 0 };
  const cutoff = at.getTime() - REPAIR_AFTER_SECONDS * 1000;
  let rows: TriggerRun[];
  try {
    rows = await deps.triggers.listRuns(trigger.projectName, trigger.triggerId, REPAIR_SCAN_LIMIT, {
      // Ask for the rows that could be dead rather than the rows that are
      // recent. On a busy trigger those sets do not overlap at all.
      startedBefore: new Date(cutoff).toISOString(),
    });
  } catch (error) {
    log.warn("trigger", `could not read runs of '${trigger.triggerId}' for repair`, error);
    return { repaired: 0, errors: 1 };
  }
  for (const row of rows) {
    // The bound is on the stored `startedAt` string, and a row whose value does
    // not parse cannot prove the run is fresh — so it repairs too. If the run is
    // somehow still alive, its own finish overwrites this.
    if (row.status !== "running" || Date.parse(row.startedAt) > cutoff) {
      continue;
    }
    try {
      await deps.triggers.finishRun({
        ...row,
        status: "failed",
        endedAt: at.toISOString(),
        error: LOST_RUN_ERROR,
      });
      summary.repaired += 1;
    } catch (error) {
      log.error("trigger", "could not repair a lost firing", error);
      summary.errors += 1;
    }
  }
  return summary;
}
