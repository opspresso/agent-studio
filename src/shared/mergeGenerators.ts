/**
 * Merge several async generators into one stream, keeping what each returned.
 *
 * `yield*` cannot do this: it drains one generator to completion before starting
 * the next, and the value it produces is that one generator's. Here every source
 * advances concurrently, values are yielded in arrival order, and the returned
 * array holds each source's return value **at its own index** — arrival order is
 * not input order, and a caller that has to pair a result with what it asked for
 * needs the latter.
 */
export async function* mergeGenerators<T, R>(
  sources: ReadonlyArray<AsyncGenerator<T, R>>,
): AsyncGenerator<T, R[]> {
  const results: R[] = [];
  /** Exactly one in-flight `next()` per source that has not finished. */
  const pending = new Map<number, Promise<{ index: number; step: IteratorResult<T, R> }>>();
  const advance = (index: number, source: AsyncGenerator<T, R>) => {
    pending.set(
      index,
      source.next().then((step) => ({ index, step })),
    );
  };
  sources.forEach((source, index) => advance(index, source));
  try {
    while (pending.size > 0) {
      // Whichever source speaks next. The losers' promises stay in the map, so
      // no source is advanced twice and none of them is dropped.
      const { index, step } = await Promise.race(pending.values());
      pending.delete(index);
      if (step.done) {
        results[index] = step.value;
        continue;
      }
      yield step.value;
      const source = sources[index];
      if (source) {
        advance(index, source);
      }
    }
  } finally {
    // A consumer that stopped early — or a source that threw — leaves the others
    // running, so every source is closed here.
    //
    // Deliberately not awaited. A generator suspended at an `await` cannot be
    // resumed by `return()` at all: the language does not deliver the request
    // until that await settles, and a subagent waiting on a model response can
    // sit there for the rest of the run. Waiting would hang the merge on the
    // slowest source instead of releasing the consumer, so closing is
    // best-effort — the call is made, the completion is not waited for.
    //
    // Rejections are absorbed rather than observed: whatever ended the loop is
    // what the caller is already handling, and an in-flight `next()` nobody is
    // reading must not surface as an unhandled rejection.
    for (const inFlight of pending.values()) {
      void inFlight.catch(() => {});
    }
    for (const source of sources) {
      // The value is discarded by any generator with a `finally`, and this merge
      // never reads it back.
      void source.return(undefined as never).catch(() => {});
    }
  }
  return results;
}
