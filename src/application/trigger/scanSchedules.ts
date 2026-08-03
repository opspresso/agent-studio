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
 *
 * That sweep covers **webhook deliveries too**, which is why it walks projects
 * rather than the schedule index: a delivery is admitted, acked and driven in
 * the background exactly like a firing, so an instance lost mid-delivery
 * strands the same row — and webhook trigger rows carry no cross-project index
 * to read them by. Giving them one would only cover triggers written after the
 * change, leaving every trigger nobody has since edited permanently
 * unrepairable while the summary read as complete. The walk costs one query per
 * project plus one per trigger, which is why it is gated to every fifth tick.
 *
 * One trigger's failure is its own: every repository call here is fenced per
 * trigger and per occurrence, because a thrown claim would otherwise abort the
 * tick with earlier occurrences already claimed — and a claim, once won, is
 * never offered again.
 */

import type { ScheduleTrigger, Trigger, TriggerRun } from "@/domain/trigger/types";
import { dueSlots, isValidTimezone, parseCron } from "@/domain/trigger/cron";
import { RUN_LEASE_SECONDS } from "@/shared/runDeadline";
import { log } from "@/shared/logger";
import { admitRun, recordSkip, type AdmittedFiring, type FiringDeps } from "./runTrigger";

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

/**
 * When a row stuck in `running` is surely dead. `startedAt` is stamped when the
 * firing is *admitted*, not when the backgrounded run actually starts, so the
 * margin over the run deadline is a full catch-up window rather than one tick —
 * repairing late is cosmetic, repairing a live run brands a healthy instance
 * as lost. One threshold for both kinds: a delivery is driven the moment it is
 * admitted, so the schedule's wider margin is the safe one for it too.
 */
export const FIRING_REPAIR_AFTER_SECONDS =
  RUN_LEASE_SECONDS + SCHEDULE_CATCHUP_WINDOW_MS / 1000;

/**
 * Repair reads history; due occurrences do not. Gating the read to every fifth
 * minute keeps the steady-state tick at one index query instead of a walk of
 * every trigger, at the cost of a repair landing a few minutes later — against
 * `FIRING_REPAIR_AFTER_SECONDS` that delay is noise.
 */
const REPAIR_EVERY_MINUTES = 5;

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
  /** Occurrences claimed but refused (overlap, superseded, no published version); each is a row. */
  skipped: number;
  /** Rows stuck in `running` past any live lease, finished as failed. Both kinds. */
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

/**
 * What a schedule firing runs: its fixed variables, and the configured message
 * when there is one. Deliberately no synthetic fallback turn — a prompt
 * project runs on its rendered template and an image project on its own
 * prompt, and an invented sentence would reach both with nothing in the
 * trigger's configuration explaining it.
 */
export function scheduleInput(trigger: ScheduleTrigger): {
  variables?: Record<string, string>;
  message?: string;
} {
  const message = trigger.message?.trim() ? trigger.message : undefined;
  return {
    ...(trigger.variables ? { variables: trigger.variables } : {}),
    ...(message ? { message } : {}),
  };
}

/** Drive firings through a bounded pool; `drive` must not throw (and does not). */
export async function driveFirings(
  firings: ScheduleFiring[],
  limit: number,
  drive: (firing: ScheduleFiring) => Promise<void>,
): Promise<void> {
  const queue = [...firings];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let firing = queue.shift(); firing; firing = queue.shift()) {
      await drive(firing);
    }
  });
  await Promise.all(workers);
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
    errors: 0,
  };
  const firings: ScheduleFiring[] = [];
  const windowStart = at.getTime() - SCHEDULE_CATCHUP_WINDOW_MS;
  if (at.getUTCMinutes() % REPAIR_EVERY_MINUTES === 0) {
    summary.repaired += await repairLostFirings(deps, at);
  }
  for (const trigger of await deps.triggers.listSchedules()) {
    summary.checked += 1;
    if (!trigger.enabled) {
      continue;
    }
    try {
      await fireDueOccurrences(deps, trigger, windowStart, at, summary, firings);
    } catch (error) {
      log.error(
        "trigger",
        `scan of schedule '${trigger.projectName}/${trigger.triggerId}' failed`,
        error,
      );
      summary.errors += 1;
    }
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
      const admitted = await admitRun(deps, trigger, { scheduledFor });
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

/**
 * Finish rows a lost instance left in `running`, per the crash policy above —
 * every trigger of every project, schedules and webhooks alike.
 *
 * Enabled is not consulted: disabling a trigger, or never firing it again, must
 * not strand the row its last firing left behind. Each project and each trigger
 * is fenced, so one unreadable partition costs its own rows and not the sweep.
 */
async function repairLostFirings(deps: FiringDeps, at: Date): Promise<number> {
  let projects;
  try {
    projects = await deps.projects.list();
  } catch (error) {
    log.warn("trigger", "could not list projects for firing repair", error);
    return 0;
  }
  let repaired = 0;
  for (const project of projects) {
    let triggers: Trigger[];
    try {
      triggers = await deps.triggers.listByProject(project.name);
    } catch (error) {
      log.warn("trigger", `could not list triggers of '${project.name}' for repair`, error);
      continue;
    }
    for (const trigger of triggers) {
      repaired += await repairLostRuns(deps, trigger, at);
    }
  }
  return repaired;
}

/** One trigger's stranded rows. */
async function repairLostRuns(
  deps: FiringDeps,
  trigger: Pick<Trigger, "projectName" | "triggerId">,
  at: Date,
): Promise<number> {
  const cutoff = at.getTime() - FIRING_REPAIR_AFTER_SECONDS * 1000;
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
