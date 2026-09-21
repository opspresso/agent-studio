/**
 * One scheduler tick: walk every schedule trigger, claim the occurrences that
 * came due, and admit a run for each claim won.
 *
 * The tick itself comes from outside the process — a deployment-owned ticker hitting
 * the scan endpoint (docs/design/triggers.md records the decision). Everything the
 * tick finds is decided here, and every instance may be ticked concurrently:
 * the per-occurrence conditional-write claim is what makes "exactly once"
 * true, not the ticker.
 *
 * Crash policy: a claim is permanent — a firing whose instance died is *not*
 * re-executed, because a run is not idempotent (its tools have side effects)
 * and the next occurrence is the natural retry. What a lost instance leaves
 * behind is a row stuck in `queued` or `running`; once its lease could no longer be live,
 * the tick finishes it as `failed` so the ledger says what happened. That sweep
 * covers **both** kinds and lives in `repairLostRuns.ts` — a webhook delivery
 * strands a row for the same reason and has no occurrence of its own to be
 * repaired by.
 *
 * One trigger's failure is its own: every repository call here is fenced per
 * trigger and per occurrence, because a thrown claim would otherwise abort the
 * tick with earlier occurrences already claimed — and a claim, once won, is
 * never offered again.
 */

import type { ScheduleTrigger } from "@/domain/trigger/types";
import { dueSlots, isValidTimezone, parseCron } from "@/domain/trigger/cron";
import { log } from "@/shared/logger";
import { mapWithLimit } from "@/shared/mapWithLimit";
import { repairLostRuns } from "./repairLostRuns";
import { admitRun, recordSkip, type AdmittedFiring } from "./runTrigger";
import type { FiringDeps } from "./deps";

/**
 * How far back a tick looks. Occurrences older than this were missed for good
 * — the window bounds how much a scanner outage can catch up on, and with it
 * how many runs a recovery may start at once. Ticks are expected at least once
 * a minute; overlapping windows are safe because the claim, not the window,
 * deduplicates.
 */
export const SCHEDULE_CATCHUP_WINDOW_MS = 10 * 60 * 1000;

/**
 * How many firings one tick's caller may drive concurrently. One 09:00 shared
 * by every project must not become that many simultaneous runs on whichever
 * instance served the tick — the per-actor concurrency guard cannot bound this
 * fan-out, because each trigger is its own actor.
 */
export const MAX_CONCURRENT_FIRINGS = 8;

/** Schedule triggers whose occurrences one tick may admit concurrently. */
export const MAX_CONCURRENT_SCHEDULE_SCANS = 8;

/** Schedule rows read from the cross-project index at once. */
export const SCHEDULE_SCAN_PAGE_SIZE = 100;

/**
 * Repair walks every project's triggers and reads their history; firing due
 * occurrences does neither. Gating the sweep to every fifth minute keeps the
 * steady-state tick at one index query, at the cost of a repair landing a few
 * minutes later — against `REPAIR_AFTER_SECONDS` that delay is noise.
 */
const REPAIR_EVERY_MINUTES = 5;

export interface ScheduleScanSummary {
  /** Schedule triggers walked, enabled or not. */
  checked: number;
  /** Occurrences claimed and queued; the caller drives each firing. */
  fired: number;
  /** Occurrences another tick or instance had already claimed — expected noise. */
  alreadyClaimed: number;
  /** Occurrences claimed but refused (overlap, superseded, no Agent configuration); each is a row. */
  skipped: number;
  /** Lost queued schedules or running rows of either kind, finished as failed. */
  repaired: number;
  /** Rows whose cron or timezone no longer parses; logged, never fatal. */
  invalid: number;
  /** Repository throws fenced off from the rest of the tick; each is logged. */
  errors: number;
}

export type ScheduleFiring = AdmittedFiring<ScheduleTrigger>;

export interface ScheduleScanResult {
  summary: ScheduleScanSummary;
  firings: ScheduleFiring[];
}

/** A schedule runs its saved message alongside the Agent's system instructions. */
export function scheduleInput(trigger: ScheduleTrigger): { message?: string } {
  return trigger.message?.trim() ? { message: trigger.message } : {};
}

/** Drive a bounded pool and close any admission its driver leaves undispatched. */
export async function driveFirings(
  firings: ScheduleFiring[],
  limit: number,
  drive: (firing: ScheduleFiring) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(limit) || limit < 1) {
    await Promise.all(firings.map((firing) => firing.release()));
    throw new Error("The firing pool requires a positive integer limit");
  }
  const queue = [...firings];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let firing = queue.shift(); firing; firing = queue.shift()) {
      try { await drive(firing); }
      catch (error) { log.error("trigger", "could not drive an admitted firing", error); }
      finally { await firing.release(); }
    }
  });
  await Promise.all(workers);
}

/**
 * The supplied instant fixes the occurrence window; admission and dispatch
 * leases use the current clock independently of that window.
 */
export async function scanSchedules(deps: FiringDeps, at: Date): Promise<ScheduleScanResult> {
  const summary: ScheduleScanSummary = {
    checked: 0,
    fired: 0,
    alreadyClaimed: 0,
    skipped: 0,
    repaired: 0,
    invalid: 0,
    errors: 0,
  };
  const firings: ScheduleFiring[] = [];
  const windowStart = at.getTime() - SCHEDULE_CATCHUP_WINDOW_MS;
  if (at.getUTCMinutes() % REPAIR_EVERY_MINUTES === 0) {
    // Once for the whole tick, not once per schedule: the sweep is by project
    // and covers webhook deliveries too, which have no occurrence of their own
    // to be repaired by.
    const repair = await repairLostRuns(deps, at);
    summary.repaired += repair.repaired;
    summary.errors += repair.errors;
  }
  let after: { projectName: string; triggerId: string } | undefined;
  for (;;) {
    let triggers: ScheduleTrigger[];
    try { triggers = await deps.triggers.listSchedules(SCHEDULE_SCAN_PAGE_SIZE, after); }
    catch (error) {
      await Promise.all(firings.map((firing) => firing.release()));
      throw error;
    }
    const scans = await mapWithLimit(
      triggers,
      MAX_CONCURRENT_SCHEDULE_SCANS,
      async (trigger): Promise<ScheduleScanResult> => {
        const triggerSummary: ScheduleScanSummary = {
          checked: 1,
          fired: 0,
          alreadyClaimed: 0,
          skipped: 0,
          repaired: 0,
          invalid: 0,
          errors: 0,
        };
        const triggerFirings: ScheduleFiring[] = [];
        if (trigger.enabled) {
          try {
            await fireDueOccurrences(
              deps,
              trigger,
              windowStart,
              at,
              triggerSummary,
              triggerFirings,
            );
          } catch (error) {
            log.error(
              "trigger",
              `scan of schedule '${trigger.projectName}/${trigger.triggerId}' failed`,
              error,
            );
            triggerSummary.errors += 1;
          }
        }
        return { summary: triggerSummary, firings: triggerFirings };
      },
    );
    for (const scan of scans) {
      summary.checked += scan.summary.checked;
      summary.fired += scan.summary.fired;
      summary.alreadyClaimed += scan.summary.alreadyClaimed;
      summary.skipped += scan.summary.skipped;
      summary.invalid += scan.summary.invalid;
      summary.errors += scan.summary.errors;
      firings.push(...scan.firings);
    }
    if (triggers.length < SCHEDULE_SCAN_PAGE_SIZE) {
      break;
    }
    const last = triggers.at(-1)!;
    after = { projectName: last.projectName, triggerId: last.triggerId };
  }
  return { summary, firings };
}

/** One trigger's due occurrences, each fenced so a throw costs only itself. */
async function fireDueOccurrences(
  deps: FiringDeps,
  trigger: ScheduleTrigger,
  windowStart: number,
  at: Date,
  summary: ScheduleScanSummary,
  firings: ScheduleFiring[],
): Promise<void> {
  const spec = parseCron(trigger.cron);
  if (!spec || !isValidTimezone(trigger.timezone)) {
    // CRUD validation makes this unreachable; a row that got here anyway must
    // not kill the tick, and must not be silent either.
    log.warn(
      "trigger",
      `schedule '${trigger.projectName}/${trigger.triggerId}' has an unusable cron or timezone`,
    );
    summary.invalid += 1;
    return;
  }
  // An occurrence older than the trigger's last edit never fires: a schedule
  // created — or re-enabled, which is an update too — mid-window must not
  // back-fire instants from before the operator's decision.
  const updatedAt = Date.parse(trigger.updatedAt);
  const after = new Date(
    Math.max(windowStart, Number.isFinite(updatedAt) ? updatedAt : windowStart),
  );
  // Newest first: with overlap disallowed, one tick catching up several missed
  // occurrences should run the *current* one — the stale ones are recorded as
  // superseded rather than executed late.
  let winner = false;
  for (const slot of dueSlots(spec, trigger.timezone, after, at).reverse()) {
    const scheduledFor = slot.toISOString();
    let claimed = false;
    try {
      claimed = await deps.triggers.claimIdempotencyKey(
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
      if (!trigger.allowConcurrent && winner) {
        await recordSkip(
          deps,
          trigger,
          { scheduledFor },
          "Superseded by a newer occurrence caught up in the same tick.",
        );
        summary.skipped += 1;
        continue;
      }
      const admitted = await admitRun(deps, trigger, { scheduledFor }, true);
      if (admitted.status === "accepted") {
        summary.fired += 1;
        winner = true;
        firings.push(admitted);
      } else {
        summary.skipped += 1;
      }
    } catch (error) {
      log.error(
        "trigger",
        `could not admit occurrence ${scheduledFor} of '${trigger.projectName}/${trigger.triggerId}'`,
        error,
      );
      summary.errors += 1;
      if (claimed) {
        // The claim is already won and will never be offered again; without a
        // row the occurrence would just silently not exist.
        await recordSkip(
          deps,
          trigger,
          { scheduledFor },
          "The scan could not admit this occurrence; see the server log.",
        );
      }
    }
  }
}
