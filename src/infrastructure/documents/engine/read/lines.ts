/** Shared run whitespace normalization; block spacing belongs to blocksToMarkdown. */

import { mergeRuns, type Run } from "../markdown";

/**
 * Whitespace inside a block's runs, collapsed the way `normalize` collapsed it
 * inside a line.
 *
 * Applied after runs are merged, not as each text event arrives:
 * `<w:t>a </w:t><w:t> b</w:t>` is two events that concatenate to `"a  b"`, and
 * collapsing each one first leaves the same double space behind.
 *
 * A run of whitespace becomes a single character, and a **tab** when the run
 * held one. In these formats a tab is not spacing that survived from a source
 * file — it is an element somebody inserted (`w:tab`, `hp:tab`), and it is how
 * columns are laid out in a document that has no table. Flattening it to a
 * space merges the columns.
 */
export function collapseRuns(runs: readonly Run[]): Run[] {
  const collapsed = runs.map((run) =>
    run.code ? run : { ...run, text: run.text.replace(/[^\S\n]+/g, (run) => (run.includes("\t") ? "\t" : " ")) },
  );
  const merged = mergeRuns(collapsed);
  const first = merged[0];
  if (first && !first.code) {
    first.text = first.text.replace(/^[^\S\n]+/, "");
  }
  const last = merged[merged.length - 1];
  if (last && !last.code) {
    last.text = last.text.replace(/[^\S\n]+$/, "");
  }
  return mergeRuns(merged).filter((run) => run.text !== "");
}
