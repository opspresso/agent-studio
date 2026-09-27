/**
 * Only the newest loader may update the screen, including loaders called after
 * an edit or deletion outside an effect. Each invocation gets a ticket whose
 * predicate becomes false when a newer one starts. Components keep the factory
 * in a `useRef`; it can also be tested without React.
 */
export function createLatestOnly(): () => () => boolean {
  let latest = 0;
  return () => {
    latest += 1;
    const ticket = latest;
    return () => ticket === latest;
  };
}
