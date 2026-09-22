import type { TriggerRun } from "@/domain/trigger/types";
import { RUN_LEASE_SECONDS } from "@/shared/runDeadline";
import { log } from "@/shared/logger";
import { unrefTimer } from "@/shared/unrefTimer";
import type { FiringDeps } from "./deps";

/** Keep the admission reservation alive without spending the execution deadline. */
export const QUEUE_HEARTBEAT_MS = Math.floor(RUN_LEASE_SECONDS * 1000 / 3);

export function queueLeaseUntil(): string {
  return new Date(Date.now() + RUN_LEASE_SECONDS * 1000).toISOString();
}

export function holdQueuedFiring(
  deps: FiringDeps,
  firing: { run: TriggerRun; release: () => Promise<void>; start?: () => Promise<boolean> },
  renewSlot: () => Promise<boolean>,
): void {
  const releaseSlot = firing.release;
  let stopped = false;
  let lost = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let updating: Promise<void> = Promise.resolve();

  const stop = () => { stopped = true; if (timer) clearTimeout(timer); };
  const close = async (reason: string) => {
    lost = true;
    stop();
    try {
      const { queueLeaseUntil: _lease, ...run } = firing.run;
      void _lease;
      await deps.triggers.updateQueuedRun(firing.run, { ...run, status: "failed", endedAt: new Date().toISOString(), error: reason });
    } catch (error) { log.error("trigger", "could not close a queued firing", error); }
    await releaseSlot();
  };
  const renew = async () => {
    try {
      if (!await renewSlot()) throw new Error("The queued firing lost its overlap reservation.");
      const previous = firing.run;
      if (Date.parse(previous.queueLeaseUntil ?? "") <= Date.now()) throw new Error("The queued firing's owner lease expired.");
      const next = { ...previous, queueLeaseUntil: queueLeaseUntil() };
      if (!await deps.triggers.updateQueuedRun(previous, next)) throw new Error("The queued firing is no longer owned by this worker.");
      firing.run = next;
    } catch (error) {
      await close(error instanceof Error ? error.message : String(error));
    }
  };
  const schedule = () => {
    timer = setTimeout(() => {
      updating = renew().then(() => { if (!stopped) schedule(); });
    }, QUEUE_HEARTBEAT_MS);
    unrefTimer(timer);
  };
  schedule();

  firing.start = async () => {
    if (stopped) return false;
    stop();
    await updating;
    if (lost) return false;
    await renew();
    if (lost) return false;
    const { queueLeaseUntil: _lease, ...previous } = firing.run;
    void _lease;
    const run: TriggerRun = { ...previous, status: "running", startedAt: new Date().toISOString() };
    try {
      if (!await deps.triggers.updateQueuedRun(firing.run, run)) throw new Error("The queued firing was closed before dispatch.");
      firing.run = run;
      return true;
    } catch (error) {
      await close(error instanceof Error ? error.message : String(error));
      return false;
    }
  };
  firing.release = async () => {
    stop();
    await updating;
    if (firing.run.status === "queued" && !lost) await close("The queued firing was stopped before dispatch.");
    else await releaseSlot();
  };
}
