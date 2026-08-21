/**
 * Coalesce token-rate appends into paced commits.
 *
 * A streamed axis arrives one token at a time, and a surface that commits each
 * one re-renders per token over a string that only grows — quadratic over the
 * run. The chat thread solves this in its store (`notifyDelayFor`); the
 * Playground and Compare hold their stream in component state and have nowhere
 * to put the same rule, so they take it from here.
 *
 * The interval grows with what has been committed, for the reason the store's
 * does: the render it schedules costs more as the text gets longer, and one
 * fixed interval either wastes renders on short answers or spends the whole
 * budget on long ones.
 */
const MIN_COMMIT_MS = 50;
const MAX_COMMIT_MS = 200;
/** One further millisecond of collecting per this many characters committed. */
const CHARS_PER_EXTRA_MS = 128;

export interface TextPacer {
  /** Take a streamed piece; it reaches `commit` on the next tick. */
  push(chunk: string): void;
  /** Commit whatever is held and stop. Safe to call more than once. */
  flush(): void;
}

/**
 * `commit` is called with the *batch*, not the whole text: the caller already
 * holds the accumulated string and appending is what its state update does.
 */
export function createTextPacer(commit: (batch: string) => void): TextPacer {
  let buffered = "";
  let committed = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function flush(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (buffered === "") {
      return;
    }
    const batch = buffered;
    buffered = "";
    committed += batch.length;
    commit(batch);
  }

  return {
    push(chunk) {
      buffered += chunk;
      if (timer !== undefined) {
        return;
      }
      const delay = Math.min(
        MAX_COMMIT_MS,
        MIN_COMMIT_MS + Math.floor(committed / CHARS_PER_EXTRA_MS),
      );
      timer = setTimeout(flush, delay);
    },
    flush,
  };
}
