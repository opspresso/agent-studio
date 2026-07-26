/**
 * The registry list shape: loading, then empty, then a grid of cards.
 *
 * Four pages — agents, tools, skills, projects — spelled this out identically,
 * down to the breakpoints. Callers keep their own `<li>` and card contents;
 * only the states and the grid live here, because those are what has to stay
 * the same across pages for the section to read as one thing.
 */

/** The card surface itself. */
export const cardClass =
  "rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900";

/** A card that is a link to its detail page. */
export const linkCardClass = `block h-full ${cardClass} transition hover:border-brand hover:shadow-sm`;

/** The grid alone, for a section that has already decided it has something to show. */
export function CardList({ children }: { children: React.ReactNode }) {
  return <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</ul>;
}

export function CardGrid({
  loading,
  empty,
  emptyText,
  children,
}: {
  loading: boolean;
  empty: boolean;
  emptyText: string;
  children: React.ReactNode;
}) {
  if (loading) {
    return <p className="text-sm text-neutral-500">Loading…</p>;
  }
  if (empty) {
    return <p className="text-sm text-neutral-500">{emptyText}</p>;
  }
  return <CardList>{children}</CardList>;
}
