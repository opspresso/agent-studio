/**
 * Run work over a list with a bound on how much is in flight.
 *
 * One owner because the alternative kept being `Promise.all(items.map(...))`,
 * which is not "concurrent" but "all at once" — and because a bound applied in
 * two nested places multiplies rather than holds. The scan tick had both
 * mistakes: an unbounded fan-out over workspaces wrapping a pool of 8 projects
 * each wrapping a pool of 8 triggers, so the stated limit of 8 was 64 per
 * workspace and unbounded across them.
 *
 * Nest these only when you mean the product. When you mean the bound, run one
 * stage, flatten, and run the next.
 */

/** At most `limit` of `work` in flight at once. Results keep the input order. */
export async function runBounded<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const queue = items.map((item, index) => ({ item, index }));
  const results = new Array<R>(items.length);
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      results[next.index] = await work(next.item, next.index);
    }
  });
  await Promise.all(workers);
  return results;
}
