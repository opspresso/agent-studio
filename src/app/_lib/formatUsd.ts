/**
 * A dollar amount, for a person.
 *
 * One owner because the same dashboard showed three: a chart that widened to
 * four decimals under a cent, a total pinned at two, and a per-row figure that
 * asked for four by hand. So the total read `$0.00` while the rows beneath it
 * added up to `$0.0043` — the page disagreeing with itself about the one number
 * it exists to report.
 *
 * The widening is the right default rather than a chart's special case. Per-call
 * LLM costs are routinely under a cent, and a currency format that rounds them
 * all to `$0.00` reports "free" for a page whose whole subject is spend.
 */
export function formatUsd(value: number, fractionDigits?: number): string {
  const digits = fractionDigits ?? (value !== 0 && Math.abs(value) < 0.01 ? 4 : 2);
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}
