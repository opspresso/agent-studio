/**
 * Coalesce token-rate appends into paced commits.
 *
 * A streamed axis arrives one token at a time, and a surface that commits each
 * one re-renders per token over a string that only grows — quadratic over the
 * run. The chat thread solves this in its store (`notifyDelayFor`); the
 * Playground holds its answer and reasoning streams in component state and uses
 * this shared pacer for both.
 *
 * The interval grows with what has been committed, for the reason the store's
 * does: the render it schedules costs more as the text gets longer, and one
 * fixed interval either wastes renders on short answers or spends the whole
 * budget on long ones.
 */
const MIN_COMMIT_MS = 50;
const MAX_COMMIT_MS = 200;
/** One further millisecond of collecting per this many characters already drawn. */
const CHARS_PER_EXTRA_MS = 128;

/**
 * How long to collect before drawing, given how much is on screen already.
 *
 * The single owner of the pacing curve. The chat thread's store asks the same
 * question about the answer it is about to re-render and the console asks it
 * about the thinking it is about to commit, and a second copy of the three
 * constants is how one surface gets retuned and the other silently does not.
 */
export function commitDelayFor(drawnChars: number): number {
  return Math.min(MAX_COMMIT_MS, MIN_COMMIT_MS + Math.floor(drawnChars / CHARS_PER_EXTRA_MS));
}

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
      timer = setTimeout(flush, commitDelayFor(committed));
    },
    flush,
  };
}
