/**
 * Only the newest run of a loader may write what is on screen.
 *
 * Two requests started in a row are two requests in flight, and they resolve in
 * arrival order rather than in the order they were asked. Without a rule the
 * slower first answer lands last: a detail page shows the record the reader
 * navigated away from, with `loading` already cleared, and it stays that way
 * until something else reloads it.
 *
 * The `cancelled` flag an effect returns (`_components/Dashboard.tsx`, and the
 * pages that reload on a date range) is the answer wherever the loader lives
 * *inside* the effect. It does not reach a loader that is also called by hand —
 * after an edit, after a delete — because nothing hands a cleanup to an
 * imperative call. This is the same rule for that shape: each run takes a
 * ticket, and only the run holding the current one may write.
 *
 * A plain factory rather than a hook so it can be tested off React; a component
 * holds one for its lifetime in a `useRef`.
 */
export function createLatestOnly(): () => () => boolean {
  let latest = 0;
  return () => {
    latest += 1;
    const ticket = latest;
    return () => ticket === latest;
  };
}
