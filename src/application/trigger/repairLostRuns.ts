/**
 * Finish expired queued/running history without replaying tool side effects.
 * Gated schedule ticks walk every Agent and trigger in bounded pages; webhook
 * completion also repairs its own trigger. Without either caller no automatic
 * repair runs. Agent enumeration covers both kinds, while TYPE#SCHEDULE serves
 * only the frequent schedule-admission scan.
 */

import type { Trigger, TriggerRun } from "@/domain/trigger/types";
import { listAgents } from "@/application/agent/agentUseCases";
import { mapWithLimit } from "@/shared/mapWithLimit";
import { RUN_LEASE_SECONDS } from "@/shared/runDeadline";
import { log } from "@/shared/logger";
import type { FiringDeps } from "./deps";
import { listAgentTriggers } from "./triggerUseCases";

/**
 * How far past the last execution owner's lease a running row must sit
 * before repair. Live renewals are authoritative regardless of startedAt.
 */
export const REPAIR_MARGIN_SECONDS = 10 * 60;

/** Start-time bound only for history with no execution-owner lease. */
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

/** Agent partitions read concurrently by one repair tick. */
export const REPAIR_AGENT_CONCURRENCY = 8;

/** What a repaired row says happened, in the place an operator will read it. */
export const LOST_RUN_ERROR =
  "The instance running this firing was lost; its lease expired without a result.";

export interface RepairSummary {
  /** Queued or running rows past their owner's lifetime, finished as failed. */
  repaired: number;
  /** Repository throws fenced off from the rest of the sweep; each is logged. */
  errors: number;
}

function merge(into: RepairSummary, from: RepairSummary): void {
  into.repaired += from.repaired;
  into.errors += from.errors;
}

/**
 * Sweep every trigger of every agent at instant `at`. Never throws: it runs
 * inside a tick whose other work must survive a single unreadable partition.
 */
export async function repairLostRuns(deps: FiringDeps, at: Date): Promise<RepairSummary> {
  let agentNames: string[];
  try {
    agentNames = (await listAgents(deps.agents)).map((agent) => agent.name);
  } catch (error) {
    // Without the agent list there is nothing to walk; the next repair tick
    // tries again, and the rows are not going anywhere.
    log.warn("trigger", "could not list agents to repair lost firings", error);
    return { repaired: 0, errors: 1 };
  }
  const agentSummaries = await mapWithLimit(
    agentNames,
    REPAIR_AGENT_CONCURRENCY,
    async (agentName): Promise<RepairSummary> => {
      const summary: RepairSummary = { repaired: 0, errors: 0 };
      let triggers: Trigger[];
      try {
        triggers = await listAgentTriggers(deps.triggers, agentName);
      } catch (error) {
        log.warn("trigger", `could not list triggers of '${agentName}' for repair`, error);
        return { repaired: 0, errors: 1 };
      }
      for (const trigger of triggers) {
        // Regardless of `enabled`: disabling a trigger must not strand the row its
        // last firing left behind.
        merge(summary, await repairTriggerRuns(deps, trigger, at));
      }
      return summary;
    },
  );
  const summary: RepairSummary = { repaired: 0, errors: 0 };
  for (const agentSummary of agentSummaries) {
    merge(summary, agentSummary);
  }
  return summary;
}

/**
 * Repair one trigger's stranded rows, isolating repository failures. Called by
 * the periodic sweep and by completion of that trigger's webhook delivery.
 */
export async function repairTriggerRuns(
  deps: FiringDeps,
  trigger: Trigger,
  at: Date,
): Promise<RepairSummary> {
  const summary: RepairSummary = { repaired: 0, errors: 0 };
  const cutoff = at.getTime() - REPAIR_AFTER_SECONDS * 1000;
  if (trigger.kind === "schedule") {
    try {
      const queued = await deps.triggers.listRuns(trigger.agentName, trigger.triggerId, REPAIR_SCAN_LIMIT, {
        status: "queued", queueLeaseBefore: at.toISOString(),
      });
      for (const row of queued) {
        if (row.status !== "queued" || Date.parse(row.queueLeaseUntil ?? "") > at.getTime()) continue;
        const { queueLeaseUntil: _lease, ...run } = row;
        void _lease;
        if (await deps.triggers.updateQueuedRun(row, { ...run, status: "failed", endedAt: at.toISOString(), error: "The instance waiting to dispatch this firing was lost; its queue lease expired." })) summary.repaired += 1;
      }
    } catch (error) {
      log.warn("trigger", "could not repair queued firings", error);
      summary.errors += 1;
    }
  }
  let rows: TriggerRun[];
  try {
    const [owned, unowned] = await Promise.all([
      deps.triggers.listRuns(trigger.agentName, trigger.triggerId, REPAIR_SCAN_LIMIT, {
        runningLeaseBefore: new Date(at.getTime() - REPAIR_MARGIN_SECONDS * 1000).toISOString(), status: "running",
      }),
      deps.triggers.listRuns(trigger.agentName, trigger.triggerId, REPAIR_SCAN_LIMIT, {
        startedBefore: new Date(cutoff).toISOString(), status: "running", unownedRunning: true,
      }),
    ]);
    rows = [...owned, ...unowned];
  } catch (error) {
    log.warn("trigger", `could not read runs of '${trigger.triggerId}' for repair`, error);
    return { repaired: summary.repaired, errors: summary.errors + 1 };
  }
  for (const row of rows) {
    // The repository filters expiry before the page limit; the write still
    // compares the returned ownership snapshot against any intervening renewal.
    const expires = row.runningLeaseToken ? Date.parse(row.runningLeaseUntil ?? "") + REPAIR_MARGIN_SECONDS * 1000
      : Date.parse(row.startedAt ?? "") + REPAIR_AFTER_SECONDS * 1000;
    if (row.status !== "running" || expires > at.getTime()) {
      continue;
    }
    try {
      const { runningLeaseToken: _token, runningLeaseUntil: _lease, ...run } = row;
      void _token; void _lease;
      if (await deps.triggers.updateRunningRun(row, {
        ...run,
        status: "failed",
        endedAt: at.toISOString(),
        error: LOST_RUN_ERROR,
      })) summary.repaired += 1;
    } catch (error) {
      log.error("trigger", "could not repair a lost firing", error);
      summary.errors += 1;
    }
  }
  return summary;
}
