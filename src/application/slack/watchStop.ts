import type { SlackRunControlRepository, SlackRunTarget } from "@/domain/slack/runControl";
import { unrefTimer } from "@/shared/unrefTimer";
import { log } from "@/shared/logger";

/** Polls a shared row so a stop delivered to any replica reaches the running agent. */
const STOP_POLL_MS = 1000;

export async function watchSlackStop(
  repository: SlackRunControlRepository,
  target: SlackRunTarget,
  messageTs: string,
  leaseToken?: string,
): Promise<{ signal: AbortSignal; check(): Promise<void>; canWrite(): boolean; dispose(): void }> {
  const controller = new AbortController();
  let disposed = false;
  let ownsLease = true;
  let pending: Promise<void> | undefined;
  async function poll() {
    try {
      if (leaseToken && !(await repository.renew(target, leaseToken))) {
        ownsLease = false;
        controller.abort(new Error("Run stopped because its thread lease was lost."));
        return;
      }
      if (await repository.stoppedAfter(target, messageTs)) {
        controller.abort(new DOMException("Stopped by user", "AbortError"));
      }
    } catch (error) {
      log.error("slack", "stop state lookup failed", error);
      // Continuing when stop delivery cannot be checked would silently ignore the user.
      controller.abort(new Error("Run stopped because its cancellation state could not be checked."));
    }
  }
  async function check() {
    if (disposed) return;
    // Await an in-flight poll: a final delivery check cannot return on stale state.
    pending ??= poll().finally(() => { pending = undefined; });
    await pending;
  }
  await check();
  const timer = setInterval(() => { void check(); }, STOP_POLL_MS);
  unrefTimer(timer);
  return { signal: controller.signal, check, canWrite: () => ownsLease,
    dispose() { disposed = true; clearInterval(timer); } };
}
