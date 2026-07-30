/**
 * Which transfer chains a run is currently producing chunks from.
 *
 * One owner for both consumers — the chat stream reducer and the Playground run
 * panel — because they answer the same question from the same `authorPath`, and
 * the second copy of this rule would drift as soon as one of them was fixed.
 */

/**
 * Add a chain to the active set, keeping only the deepest of any nested pair.
 *
 * A run that reached `sample-agent → simple-image` also produced `sample-agent`
 * chunks, and listing both reads as two separate agents. Chains that are not
 * nested all stay: `dispatch_agents` has several children speaking at once, and
 * a set that kept only the last one would flicker between them.
 */
export function mergeAuthorPath(seen: string[][], path: string[]): string[][] {
  // The trailing separator keeps the comparison on whole names: without it `img`
  // reads as a chain prefix of the unrelated agent `image-agent`.
  const key = (candidate: string[]) => `${candidate.join(">")}>`;
  if (seen.some((existing) => key(existing).startsWith(key(path)))) {
    return seen;
  }
  return [...seen.filter((existing) => !key(path).startsWith(key(existing))), path];
}

/** The chain a chunk came from, or nothing when it is the top-level agent's. */
export function chunkAuthorPath(chunk: {
  author?: string;
  authorPath?: string[];
}): string[] | undefined {
  return chunk.authorPath ?? (chunk.author ? [chunk.author] : undefined);
}
