import type { SlackRunControlRepository, SlackRunTarget } from "@/domain/slack/runControl";
import { unrefTimer } from "@/shared/unrefTimer";
import { log } from "@/shared/logger";

/** Polls a shared row so a stop delivered to any replica reaches the running agent. */
const STOP_POLL_MS = 1000;

export async function watchSlackStop(
  repository: SlackRunControlRepository,
  target: SlackRunTarget,
  messageTs: string,
): Promise<{ signal: AbortSignal; dispose(): void }> {
  const controller = new AbortController();
  let disposed = false;
  let pending = false;
  async function check() {
    if (disposed || pending || controller.signal.aborted) return;
    pending = true;
    try {
      if (await repository.stoppedAfter(target, messageTs)) {
        controller.abort(new DOMException("Stopped by user", "AbortError"));
      }
    } catch (error) {
      log.error("slack", "stop state lookup failed", error);
      // Continuing when stop delivery cannot be checked would silently ignore the user.
      controller.abort(new Error("Run stopped because its cancellation state could not be checked."));
    } finally {
      pending = false;
    }
  }
  await check();
  const timer = setInterval(() => { void check(); }, STOP_POLL_MS);
  unrefTimer(timer);
  return { signal: controller.signal, dispose() { disposed = true; clearInterval(timer); } };
}
