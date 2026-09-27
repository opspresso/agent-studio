import { chunkAuthorPath, isTopLevelChunk, runTermination } from "@/domain/llm/types";
import type { EngineChunk } from "@/domain/llm/types";

/**
 * Shared Chat and Playground tracking for Agent participation and activity.
 *
 * Shared by Chat and Playground. Visited paths describe participation; active
 * paths describe current execution, so they use different collapse rules:
 *
 * - **visited** — every chain this run reached, for "agents involved". Grows, and
 *   a deeper chain absorbs the shallower one it extends.
 * - **active** — current chains scoped to each native invocation. A chain
 *   replaces nested paths within that invocation; completion cannot remove siblings.
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
 * Update one invocation's paths. A parent path replaces its nested child and a
 * child path replaces its waiting parent; independent chains remain visible.
 * `foldActiveAuthors` isolates invocations before applying this rule.
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

export { chunkAuthorPath };

/** An active invocation; two calls of one Agent keep separate completion state. */
export interface ActiveAuthor {
  path: string[];
  transferId?: string;
}

type ActivityChunk = Pick<EngineChunk,
  "author" | "authorPath" | "transferId" | "authorDone" | "done" | "finishReason" | "error"
> & { delta?: { content?: string; reasoningContent?: string } };

/**
 * Fold activity by invocation. Tool results and warnings can arrive while sibling
 * tools still run; only parent model output or termination clears the whole set.
 */
export function foldActiveAuthors(active: ActiveAuthor[], chunk: ActivityChunk): ActiveAuthor[] {
  const path = chunkAuthorPath(chunk);
  if (!path) {
    const parentOutput = isTopLevelChunk(chunk) &&
      (runTermination(chunk) !== undefined || chunk.delta?.content !== undefined ||
        chunk.delta?.reasoningContent !== undefined);
    return parentOutput ? [] : active;
  }
  const invocation = active.filter(entry => entry.transferId === chunk.transferId);
  const paths = invocation.map(entry => entry.path);
  const updated = chunk.authorDone ? removeActivePath(paths, path) : trackActivePath(paths, path);
  return [
    ...active.filter(entry => entry.transferId !== chunk.transferId),
    ...updated.map(path => ({ path, ...(chunk.transferId === undefined ? {} : { transferId: chunk.transferId }) })),
  ];
}

/** Show each active chain once while preserving its independent invocations. */
export function activeAuthorPaths(active: ActiveAuthor[]): string[][] {
  const seen = new Set<string>();
  return active.flatMap(entry => {
    const id = key(entry.path);
    if (seen.has(id)) return [];
    seen.add(id);
    return [entry.path];
  });
}
