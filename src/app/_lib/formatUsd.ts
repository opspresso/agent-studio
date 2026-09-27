/**
 * Shared USD display: four decimals for nonzero amounts below one cent, two
 * otherwise. Callers can explicitly choose another precision.
 */
export function formatUsd(value: number, fractionDigits?: number): string {
  const digits = fractionDigits ?? (value !== 0 && Math.abs(value) < 0.01 ? 4 : 2);
  // Pinned to en-US rather than the viewer's locale: the `$` is already
  // hardcoded, and an environment-dependent locale (Node ICU on the server,
  // the browser on the client) is a hydration mismatch for any reader whose
  // locale groups digits differently.
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}
