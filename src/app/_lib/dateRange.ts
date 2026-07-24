/** Shared date-range helpers for the usage/trace date pickers. */

export interface DateRange {
  from: string;
  to: string;
}

/** YYYY-MM-DD in UTC. */
export function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A range ending today, spanning `days` days inclusive. */
export function presetRange(days: number): DateRange {
  const to = new Date();
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return { from: toISODate(from), to: toISODate(to) };
}

/** Preset spans (in days) offered as quick-select buttons. */
export const DATE_PRESETS = [7, 14, 30] as const;

/** Default range: the last 30 days. */
export function defaultDateRange(): DateRange {
  return presetRange(30);
}
