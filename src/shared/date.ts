/**
 * Date formatting accepts an explicit locale so console language does not
 * depend on the runtime default. Date/time display uses the runtime timezone;
 * a locale alone does not align server and browser timezones. UTC helpers
 * below ignore locale, while the prompt clock uses a fixed UTC/en-US format.
 */
type DateLocale = Intl.LocalesArgument;

function parsedDate(value: string): Date | null {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime()) ? date : null;
}

/**
 * Parse a stored timestamp for calculations using the same missing/invalid
 * rule as display formatting. An empty string yields null, never the epoch.
 */
export function parsedInstant(value: string): number | null {
  return parsedDate(value)?.getTime() ?? null;
}

/** Locale date only (year included). Empty string for missing/invalid input. */
export function formatDate(value: string, locale?: DateLocale): string {
  const date = parsedDate(value);
  return date
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date)
    : "";
}

/** Compact date-time for chat bubbles (e.g. "7/23 14:32"). Empty string for missing/invalid input. */
export function formatShortDateTime(iso: string, locale?: DateLocale): string {
  const date = parsedDate(iso);
  if (!date) {
    return "";
  }
  return date.toLocaleString(locale, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Full locale date-time (year included). Empty string for missing/invalid input. */
export function formatDateTime(iso: string, locale?: DateLocale): string {
  const date = parsedDate(iso);
  return date
    ? new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date)
    : "";
}

/**
 * UTC day (`YYYY-MM-DD`) shared by usage keys, date ranges and readers.
 */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Validate a real UTC calendar day, `YYYY-MM-DD`. Shape validation alone
 * accepts impossible dates; round-tripping rejects normalization into another
 * day as well as invalid parsing.
 */
export function isUtcDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return false;
  }
  const at = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(at) && utcDay(new Date(at)) === day;
}

export const MS_PER_DAY = 86_400_000;

/**
 * Count UTC days in `[from, to]`, including both endpoints, without allocating
 * a list. Invalid dates yield NaN. Validate external inputs with isUtcDay
 * before comparing a range against its budget.
 */
export function daySpan(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / MS_PER_DAY) + 1;
}

/**
 * Enumerate UTC days in `[from, to]`, oldest first, including both endpoints.
 * Callers validate external days and enforce a range budget before enumerating.
 * Consumers needing reverse order reverse this result rather than reimplementing
 * calendar arithmetic.
 */
export function daysBetween(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const days: string[] = [];
  // A day that cannot be read makes this `NaN <= NaN`, so the range is empty
  // rather than infinite.
  for (let at = start; at <= end; at += MS_PER_DAY) {
    days.push(utcDay(new Date(at)));
  }
  return days;
}

/** YYYY-MM in UTC — the month a monthly cost window is keyed by. */
export function utcMonth(date: Date): string {
  return date.toISOString().slice(0, 7);
}


/**
 * UTC prompt clock with an explicit timezone and weekday. Minute precision
 * gives relative-date reasoning a current reference while preserving prompt
 * cache stability within the minute.
 */
export function formatRunClock(date: Date): string {
  const iso = date.toISOString();
  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: "UTC",
  }).format(date);
  return `${iso.slice(0, 10)} (${weekday}) ${iso.slice(11, 16)} UTC`;
}
