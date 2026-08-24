/**
 * Run `fn` over `items` with at most `limit` in flight; results keep input order.
 *
 * Here rather than beside either caller because neither owns it: the engine
 * bounds a turn's tool dispatch with it, and the Slack reader bounds a
 * transcript's profile lookups — the same shape, no shared subject. A second
 * copy is how the two would drift on the one thing that matters, which is that
 * a rejection inside `fn` must reject the whole call rather than stall the
 * remaining workers.
 *
 * Every item is run, and a missing result is not a shape this can produce. That
 * is load-bearing rather than obvious: the engine pairs results back to calls by
 * index and skips a slot it finds empty, so anything that returns short here
 * does not fail — it silently answers a tool call with nothing.
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  // At least one worker. A `limit` of zero or less would otherwise start none,
  // and `Promise.all([])` settles immediately with an array of holes — every
  // call answered with nothing, and no error anywhere to say so. `NaN` is named
  // rather than clamped: it survives both `Math.max` and `Math.min`, and
  // `Array.from({ length: NaN })` is the empty array — the same silence by
  // another route.
  const wanted = Number.isFinite(limit) ? Math.floor(limit) : 1;
  const workerCount = Math.min(Math.max(wanted, 1), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) {
        return;
      }
      // The bounds check is what makes the element present; the compiler cannot
      // see it through `noUncheckedIndexedAccess`. Reading the element and
      // treating an `undefined` *value* as the end of the work conflated the
      // two: an item that is legitimately `undefined` retired the worker that
      // met it, so at `limit: 1` everything after it was never run at all.
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}
