/**
 * The shape extracted text comes out in, shared by every reader.
 *
 * One owner because the shape is a contract: a caller comparing two documents,
 * or a test asserting a round trip, is comparing this normalisation as much as
 * it is comparing the text. Two readers that trimmed differently would make
 * "the same document" depend on which one read it.
 *
 * It used to be `normalize`, over lines. Two of its three jobs moved here and
 * the third was **deleted**: it stripped a trailing `|` from every line,
 * because the readers glued cells together with `" | "` and the last one left a
 * dangling separator behind. Cells are `ReadCell`s now, so the artifact it
 * removed does not occur — and it could not have survived either way, since it
 * would eat the closing pipe of every GFM row. Blank-line spacing between
 * blocks belongs to `blocksToMarkdown`, which knows where a block ends.
 */

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
