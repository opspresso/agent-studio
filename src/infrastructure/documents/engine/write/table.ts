/** Content-weighted column shares for DOCX, HWPX, PDF and PPTX; demand clamps prevent a long cell dominating. */

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
