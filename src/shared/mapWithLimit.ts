/**
 * Run `fn` over `items` with at most `limit` in flight; results keep input order.
 *
 * Here rather than beside either caller because neither owns it: the engine
 * bounds a turn's tool dispatch with it, and the Slack reader bounds a
 * transcript's profile lookups — the same shape, no shared subject. A second
 * copy is how the two would drift on the one thing that matters, which is that
 * a rejection inside `fn` must reject the whole call rather than stall the
 * remaining workers.
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      const item = items[index];
      if (index >= items.length || item === undefined) {
        return;
      }
      results[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}
