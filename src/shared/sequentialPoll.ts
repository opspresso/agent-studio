import { unrefTimer } from "./unrefTimer";

export interface SequentialPollOptions {
  intervalMs: number;
  poll(signal: AbortSignal): Promise<void>;
  onError(error: unknown): void;
}

/** Poll after the previous read finishes, with at most one read in flight. */
export function startSequentialPoll(options: SequentialPollOptions): () => void {
  const lifecycle = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    try {
      await options.poll(lifecycle.signal);
    } catch (error) {
      if (!lifecycle.signal.aborted) {
        options.onError(error);
      }
    } finally {
      if (!lifecycle.signal.aborted) {
        schedule();
      }
    }
  };
  const schedule = () => {
    timer = setTimeout(() => {
      void run();
    }, options.intervalMs);
    unrefTimer(timer);
  };
  schedule();
  return () => {
    lifecycle.abort();
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  };
}
