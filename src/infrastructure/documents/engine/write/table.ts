/**
 * How wide each column of a table should be, as a share of the whole.
 *
 * Shared by the three renderers because it is the one table decision that is
 * about the *content* rather than about the format: an id column next to a
 * column of prose should not get half the table, and which unit the answer is
 * expressed in — points, twentieths of a point, HWPUNIT — is the only thing
 * that differs between them.
 *
 * Character counts rather than measured text: the three renderers measure in
 * three different fonts, and a column layout that changed with the format would
 * make the same document look like three documents. The clamp is what stops one
 * long cell from squeezing every other column down to a character per line.
 */

import type { Run } from "../markdown";

const MIN_SHARE = 0.1;
const MAX_SHARE = 0.6;
/** A column of nothing still needs to be visible. */
const MIN_DEMAND = 4;

export function columnShares(rows: readonly Run[][][], columns: number): number[] {
  const demand = Array.from({ length: columns }, (_, column) =>
    Math.max(
      MIN_DEMAND,
      ...rows.map((row) => (row[column] ?? []).reduce((sum, run) => sum + run.text.length, 0)),
    ),
  );
  const total = demand.reduce((sum, value) => sum + value, 0);
  const clamped = demand.map((value) =>
    Math.min(MAX_SHARE, Math.max(MIN_SHARE, value / total)),
  );
  // Renormalised after clamping, so the shares still add up to the table.
  const scale = clamped.reduce((sum, value) => sum + value, 0);
  return clamped.map((value) => value / scale);
}
