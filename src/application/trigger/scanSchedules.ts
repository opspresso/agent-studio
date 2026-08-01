/**
 * One scheduler tick: walk every schedule trigger, claim the occurrences that
 * came due, and admit a run for each claim won.
 *
 * The tick itself comes from outside the process — a Kubernetes CronJob hitting
 * the scan endpoint (docs/ARCHITECTURE.md records the decision). Everything the
 * tick finds is decided here, and every instance may be ticked concurrently:
 * the per-occurrence conditional-write claim is what makes "exactly once"
 * true, not the ticker.
 *
 * Crash policy: a claim is permanent — a firing whose instance died is *not*
 * re-executed, because a run is not idempotent (its tools have side effects)
 * and the next occurrence is the natural retry. What a lost instance leaves
 * behind is a row stuck in `running`; once its lease could no longer be live,
 * the scan finishes it as `failed` so the ledger says what happened.
 */

import type { ScheduleTrigger, TriggerRun } from "@/domain/trigger/types";
import { dueSlots, isValidTimezone, parseCron } from "@/domain/trigger/cron";
import { RUN_LEASE_SECONDS } from "@/shared/runDeadline";
import { log } from "@/shared/logger";
import { admitRun, type AdmittedFiring, type FiringDeps } from "./runTrigger";

/**
 * How far back a tick looks. Occurrences older than this were missed for good
 * — the window bounds how much a scanner outage can catch up on, and with it
 * how many runs a recovery may start at once. Ticks are expected at least once
 * a minute; overlapping windows are safe because the claim, not the window,
 * deduplicates.
 */
export const SCHEDULE_CATCHUP_WINDOW_MS = 10 * 60 * 1000;

/**
 * How many recent history rows one repair pass reads. Newest first, so this
 * only needs to cover what one lease-length of firings can write.
 */
const REPAIR_SCAN_LIMIT = 50;

export interface ScheduleScanSummary {
  /** Schedule triggers walked, enabled or not. */
  checked: number;
  /** Occurrences claimed and admitted; the caller drives each firing. */
  fired: number;
  /** Occurrences another tick or instance had already claimed — expected noise. */
  alreadyClaimed: number;
  /** Occurrences claimed but refused (overlap, no published version); each is a row. */
  skipped: number;
  /** Rows stuck in `running` past any live lease, finished as failed. */
  repaired: number;
  /** Rows whose cron or timezone no longer parses; logged, never fatal. */
  invalid: number;
}

export type ScheduleFiring = AdmittedFiring<ScheduleTrigger>;

export interface ScheduleScanResult {
  summary: ScheduleScanSummary;
  firings: ScheduleFiring[];
}

/** What a schedule firing runs: its fixed variables and configured message. */
export function scheduleInput(trigger: ScheduleTrigger): {
  variables?: Record<string, string>;
  message: string;
} {
  return {
    ...(trigger.variables ? { variables: trigger.variables } : {}),
    message: trigger.message?.trim() ? trigger.message : "Schedule fired with no configured message.",
  };
}

/**
 * Scan at instant `at`. Pure with respect to time — the caller supplies the
 * clock, so a test can hold it still.
 */
export async function scanSchedules(deps: FiringDeps, at: Date): Promise<ScheduleScanResult> {
  const summary: ScheduleScanSummary = {
    checked: 0,
    fired: 0,
    alreadyClaimed: 0,
    skipped: 0,
    repaired: 0,
    invalid: 0,
  };
  const firings: ScheduleFiring[] = [];
  const windowStart = new Date(at.getTime() - SCHEDULE_CATCHUP_WINDOW_MS);
  for (const trigger of await deps.triggers.listSchedules()) {
    summary.checked += 1;
    // Repair before the enabled check: disabling a schedule must not strand a
    // row its last firing left in `running`.
    summary.repaired += await repairLostRuns(deps, trigger, at);
    if (!trigger.enabled) {
      continue;
    }
    const spec = parseCron(trigger.cron);
    if (!spec || !isValidTimezone(trigger.timezone)) {
      // CRUD validation makes this unreachable; a row that got here anyway must
      // not kill the tick, and must not be silent either.
      log.warn(
        "trigger",
        `schedule '${trigger.projectName}/${trigger.triggerId}' has an unusable cron or timezone`,
      );
      summary.invalid += 1;
      continue;
    }
    for (const slot of dueSlots(spec, trigger.timezone, windowStart, at)) {
      const scheduledFor = slot.toISOString();
      const claimed = await deps.triggers.claimIdempotencyKey(
        trigger.projectName,
        trigger.triggerId,
        `schedule:${scheduledFor}`,
      );
      if (!claimed) {
        summary.alreadyClaimed += 1;
        continue;
      }
      // The occurrence is ours from here on: whatever refuses it now is
      // recorded as a skipped row rather than retried by anyone else.
      const admitted = await admitRun(deps, trigger, { scheduledFor });
      if (admitted.status === "accepted") {
        summary.fired += 1;
        firings.push(admitted);
      } else {
        summary.skipped += 1;
      }
    }
  }
  return { summary, firings };
}

/** Finish rows a lost instance left in `running`, per the crash policy above. */
async function repairLostRuns(
  deps: FiringDeps,
  trigger: ScheduleTrigger,
  at: Date,
): Promise<number> {
  const cutoff = at.getTime() - RUN_LEASE_SECONDS * 1000;
  let rows: TriggerRun[];
  try {
    rows = await deps.triggers.listRuns(trigger.projectName, trigger.triggerId, REPAIR_SCAN_LIMIT);
  } catch (error) {
    log.warn("trigger", `could not read runs of '${trigger.triggerId}' for repair`, error);
    return 0;
  }
  let repaired = 0;
  for (const row of rows) {
    // An unparseable startedAt cannot prove the run is fresh, so it repairs
    // too; if the run is somehow still alive, its own finish overwrites this.
    if (row.status !== "running" || Date.parse(row.startedAt) > cutoff) {
      continue;
    }
    try {
      await deps.triggers.finishRun({
        ...row,
        status: "failed",
        endedAt: at.toISOString(),
        error: "The instance running this firing was lost; its lease expired without a result.",
      });
      repaired += 1;
    } catch (error) {
      log.error("trigger", "could not repair a lost firing", error);
    }
  }
  return repaired;
}
