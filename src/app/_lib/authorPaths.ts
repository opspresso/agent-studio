/**
 * Which transfer chains a run is producing chunks from.
 *
 * One owner for both consumers — the chat stream reducer and the Playground run
 * panel — because they read the same `authorPath` off the same chunks, and a
 * second copy of these rules would drift as soon as one of them was fixed.
 *
 * Two *different* questions, so two functions. Answering them with one is how a
 * finished agent ended up still being shown as running:
 *
 * - **visited** — every chain this run reached, for "agents involved". Grows, and
 *   a deeper chain absorbs the shallower one it extends.
 * - **active** — the chains producing chunks *now*, for the running badge. A
 *   chain replaces whatever it is nested with, in either direction.
 */

/** The trailing separator keeps comparisons on whole names: without it `img` reads
 * as a chain prefix of the unrelated agent `image-agent`. */
const key = (path: string[]) => `${path.join(">")}>`;

/**
 * Add a chain to the visited set, keeping only the deepest of any nested pair.
 *
 * A run that reached `sample-agent → simple-image` also produced `sample-agent`
 * chunks, and listing both reads as two separate agents. Nothing is ever removed
 * for having finished — this set is the history of the run.
 */
export function mergeVisitedPath(seen: string[][], path: string[]): string[][] {
  if (seen.some((existing) => key(existing).startsWith(key(path)))) {
    return seen;
  }
  return [...seen.filter((existing) => !key(path).startsWith(key(existing))), path];
}

/**
 * Move the active set to the chain that just spoke.
 *
 * A chain evicts any chain it is nested with, **in either direction**: a parent
 * speaking again means its child returned (a transfer blocks until it does), and
 * a child speaking means the parent is waiting on it. Chains that are not nested
 * all stay — `dispatch_agents` has several children running at once, and a set
 * that kept only the last one to speak would flicker between them.
 *
 * This is where the visited rule cannot be reused: keeping the deeper chain would
 * leave a finished subagent on screen until the whole dispatch returned.
 */
export function trackActivePath(active: string[][], path: string[]): string[][] {
  const incoming = key(path);
  return [
    ...active.filter((existing) => {
      const existingKey = key(existing);
      return !existingKey.startsWith(incoming) && !incoming.startsWith(existingKey);
    }),
    path,
  ];
}

/** Remove a completed chain and anything nested beneath it. */
export function removeActivePath(active: string[][], path: string[]): string[][] {
  const completed = key(path);
  return active.filter((existing) => !key(existing).startsWith(completed));
}

/** The chain a chunk came from, or nothing when it is the top-level agent's. */
export function chunkAuthorPath(chunk: {
  author?: string;
  authorPath?: string[];
}): string[] | undefined {
  return chunk.authorPath ?? (chunk.author ? [chunk.author] : undefined);
}
