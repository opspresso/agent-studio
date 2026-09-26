const INPUT_PAUSE_MS = 200;
const MAX_INPUT_WAIT_MS = 1_000;
const MIN_REQUEST_INTERVAL_MS = 1_000;

/** One active request; edits coalesce into the latest draft without cancelling inference. */
export function createAgentSuggestionQueue(
  recommend: (text: string, signal: AbortSignal) => Promise<void>,
  now: () => number = () => performance.now(),
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let pending: string | undefined;
  let firstEditAt: number | undefined;
  let lastEditAt = 0;
  let lastStartedAt = -Infinity;
  let lastSent: string | undefined;
  let blockedUntil = 0;
  let closed = false;

  function clearTimer() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function schedule() {
    clearTimer();
    if (closed || controller || pending === undefined || firstEditAt === undefined) return;
    const due = Math.max(
      blockedUntil,
      lastStartedAt + MIN_REQUEST_INTERVAL_MS,
      Math.min(lastEditAt + INPUT_PAUSE_MS, firstEditAt + MAX_INPUT_WAIT_MS),
    );
    timer = setTimeout(dispatch, Math.max(0, due - now()));
  }

  function dispatch() {
    timer = undefined;
    if (closed || controller || pending === undefined) return;
    const text = pending;
    pending = undefined;
    firstEditAt = undefined;
    lastSent = text;
    lastStartedAt = now();
    controller = new AbortController();
    // The caller reports request failures; completion releases the next edited draft.
    void recommend(text, controller.signal).finally(() => {
      controller = undefined;
      schedule();
    });
  }

  return {
    update(text: string) {
      if (closed) return;
      if (!text) {
        pending = undefined;
        firstEditAt = undefined;
        lastSent = undefined;
        clearTimer();
        controller?.abort();
        return;
      }
      if (text === lastSent) {
        pending = undefined;
        firstEditAt = undefined;
        clearTimer();
        return;
      }
      pending = text;
      lastEditAt = now();
      firstEditAt ??= lastEditAt;
      schedule();
    },
    /** Honor server admission without retrying an unchanged failed request. */
    cooldown(milliseconds: number) {
      blockedUntil = Math.max(blockedUntil, now() + milliseconds);
      schedule();
    },
    stop() {
      closed = true;
      pending = undefined;
      clearTimer();
      controller?.abort();
    },
  };
}
