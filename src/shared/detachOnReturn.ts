/**
 * Let a consumer walk away from a stream without ending the work behind it.
 *
 * A streaming route hands its generator to a `ReadableStream`, and the browser
 * closing the connection calls that stream's `cancel()` — which closes the
 * generator, which unwinds the run producing it. For a chat that is wrong: the
 * answer is worth finishing whether or not anyone is still reading, and the
 * reader may well come back for it. Wrapping the source here turns the
 * consumer's `return()` from "stop" into "I am leaving": the source keeps being
 * pulled to completion in the background, and `drained` says when that finished.
 *
 * **Not an `async function*`.** `src/shared/mergeGenerators.ts` documents why: a
 * generator suspended at an `await` cannot be resumed by `return()` at all — the
 * language does not deliver the request until that await settles, and a run
 * waiting on a model response can sit there for minutes. A wrapper written as a
 * generator would therefore make `cancel()` hang for the rest of the run, which
 * is the exact failure it exists to prevent. Hence a hand-rolled iterator, whose
 * `return()` answers immediately.
 *
 * For the same reason this must be the **outermost** thing the response
 * consumes. A plain `async function*` layered above it (an envelope frame, say)
 * would swallow `return()` before it ever arrived here.
 *
 * One chunk is lost to the pump at the moment of detach: the `next()` already in
 * flight resolves into the leaving consumer, which discards it. That is harmless
 * only because everything that *observes* chunks — persistence, the run log —
 * sits below this wrapper and has already acted on a chunk before yielding it.
 * An observer added above the detach point would silently lose one per
 * disconnect.
 */

import { log } from "./logger";

export interface DetachedStream<T> {
  /** What the response consumes. Its `return()` detaches instead of closing the source. */
  stream: AsyncGenerator<T>;
  /**
   * Settles when the source is exhausted, whoever ended up pulling it. **Never
   * rejects**: a rejection here reaches whatever is awaiting the detached work
   * (`after()` in a route), which reports it outside `src/shared/logger.ts`.
   */
  drained: Promise<void>;
}

export function detachOnReturn<T>(
  source: AsyncGenerator<T>,
  /** Called once, when the consumer leaves — never on a normal end of stream. */
  onDetach?: () => void,
): DetachedStream<T> {
  let settle!: () => void;
  const drained = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let finished = false;
  let detached = false;

  // Idempotent: the source can reach its end through the consumer, through the
  // pump, or through a throw, and `drained` must settle exactly once on each.
  function finish(): void {
    if (!finished) {
      finished = true;
      settle();
    }
  }

  async function pump(): Promise<void> {
    try {
      for (;;) {
        const step = await source.next();
        if (step.done) {
          return;
        }
      }
    } catch (error) {
      // The consumer is gone, so there is nowhere to report this but the log.
      log.error("run", "detached work failed after the client left", error);
    } finally {
      finish();
    }
  }

  const stream: AsyncGenerator<T> = {
    async next(): Promise<IteratorResult<T>> {
      if (detached || finished) {
        return { done: true, value: undefined };
      }
      let step: IteratorResult<T>;
      try {
        step = await source.next();
      } catch (error) {
        // The refusal path: a run over its cost limit throws on the very first
        // `next()`, before a response exists. Nothing will detach, so settle
        // here or `drained` never resolves.
        finish();
        throw error;
      }
      if (step.done) {
        finish();
      }
      return step;
    },
    async return(): Promise<IteratorResult<T>> {
      if (!detached && !finished) {
        detached = true;
        onDetach?.();
        // Deliberately not awaited — that is the whole point. The pump's own
        // pending I/O is what keeps it alive; `drained` is how a caller waits.
        void pump();
      }
      return { done: true, value: undefined };
    },
    async throw(error: unknown): Promise<IteratorResult<T>> {
      // Only `yield*` delegation calls this, and nothing delegates through a
      // detaching wrapper. Treated as leaving, then rethrown to the caller.
      await stream.return(undefined);
      throw error;
    },
    [Symbol.asyncIterator](): AsyncGenerator<T> {
      return stream;
    },
    // Disposal is leaving, like every other way out of this wrapper.
    async [Symbol.asyncDispose](): Promise<void> {
      await stream.return(undefined);
    },
  };

  return { stream, drained };
}
