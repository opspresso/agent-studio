import { randomUUID } from "node:crypto";
import type { TriggerRun } from "@/domain/trigger/types";
import { RUN_LEASE_SECONDS } from "@/shared/runDeadline";
import { unrefTimer } from "@/shared/unrefTimer";
import type { FiringDeps } from "./deps";

/** Admission, execution and settlement share one owner lifetime. */
export const FIRING_HEARTBEAT_MS = Math.floor(RUN_LEASE_SECONDS * 1000 / 3);

export function runningLease(): Required<Pick<TriggerRun, "runningLeaseToken" | "runningLeaseUntil">> {
  return { runningLeaseToken: randomUUID(), runningLeaseUntil: new Date(Date.now() + RUN_LEASE_SECONDS * 1000).toISOString() };
}

export interface RunningFiring {
  run: TriggerRun;
  release(): Promise<void>;
  signal?: AbortSignal;
  check?: () => Promise<void>;
  finish?: (run: TriggerRun) => Promise<boolean>;
}

/** Renew both reservations and fence effects after either ownership check fails. */
export function holdRunningFiring(deps: FiringDeps, firing: RunningFiring, renewSlot: () => Promise<boolean>): void {
  const releaseSlot = firing.release;
  const controller = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let confirmedUntil = Date.parse(firing.run.runningLeaseUntil ?? "");
  let updating: Promise<void> = Promise.resolve();
  const stop = () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
  };
  const lose = (error: unknown) => {
    stop();
    controller.abort(error instanceof Error ? error : new Error("The firing lost its execution ownership."));
  };
  const requireLiveOwner = () => {
    controller.signal.throwIfAborted();
    if (!Number.isFinite(confirmedUntil) || confirmedUntil <= Date.now()) {
      throw new Error("The firing's execution owner lease expired.");
    }
  };
  const scheduleExpiry = () => {
    if (stopped) return;
    try { requireLiveOwner(); } catch (error) { lose(error); return; }
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    // A pending database request cannot extend the last acknowledged lease.
    // Split long waits using the heartbeat interval to stay within timer limits.
    expiryTimer = setTimeout(scheduleExpiry, Math.min(confirmedUntil - Date.now(), FIRING_HEARTBEAT_MS));
    unrefTimer(expiryTimer);
  };
  const renew = async () => {
    if (stopped || controller.signal.aborted) return;
    try {
      const previous = firing.run;
      requireLiveOwner();
      if (previous.status !== "running") throw new Error("The firing has already settled.");
      if (!await renewSlot()) throw new Error("The firing lost its overlap reservation.");
      requireLiveOwner();
      if (stopped) return;
      const next = { ...previous, runningLeaseUntil: new Date(Date.now() + RUN_LEASE_SECONDS * 1000).toISOString() };
      if (!await deps.triggers.updateRunningRun(previous, next)) throw new Error("The firing is no longer owned by this worker.");
      requireLiveOwner();
      if (stopped) return;
      firing.run = next;
      confirmedUntil = Date.parse(next.runningLeaseUntil);
      scheduleExpiry();
    } catch (error) { lose(error); }
  };
  const schedule = () => {
    timer = setTimeout(() => {
      updating = updating.then(renew).then(() => { if (!stopped) schedule(); });
    }, FIRING_HEARTBEAT_MS);
    unrefTimer(timer);
  };
  firing.signal = controller.signal;
  firing.check = async () => {
    controller.signal.throwIfAborted();
    if (stopped) throw new Error("The firing has already settled.");
    updating = updating.then(renew);
    await updating;
    controller.signal.throwIfAborted();
  };
  firing.finish = async result => {
    const { runningLeaseToken: _token, runningLeaseUntil: _lease, ...terminal } = result;
    void _token; void _lease;
    try {
      for (;;) {
        await updating;
        const previous = firing.run;
        if (controller.signal.aborted && terminal.status !== "failed") return false;
        // Loss may be recorded against the unchanged owner snapshot after expiry;
        // success still requires a live lease, and any intervening repair fences both.
        const saved = await deps.triggers.updateRunningRun(previous, terminal, { requireLiveOwner: terminal.status !== "failed" });
        if (saved) { firing.run = terminal; return true; }
        // Only a completed renewal by this owner permits another conditional
        // history write. An unknown write outcome is never replayed.
        if (firing.run === previous || controller.signal.aborted) {
          lose(new Error("The firing settlement lost its execution owner."));
          return false;
        }
      }
    } finally { stop(); await updating; }
  };
  firing.release = async () => {
    stop();
    await updating;
    await releaseSlot();
  };
  schedule();
  scheduleExpiry();
}
