/**
 * The language a timestamp is written in.
 *
 * Passing it is what makes the server and the browser agree: left to the
 * runtime's own default, Node writes `8/14/2026` while a Korean browser writes
 * `2026. 8. 14.` for the same instant, and React throws away the tree it
 * hydrated. It also means a reader who chose Korean gets Korean dates whatever
 * their browser is set to — which is the point of the choice.
 *
 * Optional because the non-UI callers here (`utcDay` and friends) have no
 * locale and want none; omitting it keeps the old runtime-default behaviour.
 */
type DateLocale = Intl.LocalesArgument;

function parsedDate(value: string): Date | null {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime()) ? date : null;
}

/**
 * A stored timestamp as milliseconds, or `null` when it cannot be read.
 *
 * The same judgement the formatters above make, published for a caller that
 * wants to measure with the value rather than print it: an unreadable
 * `createdAt` yields nothing, and deciding that twice is how one reader comes
 * to treat `""` as the epoch while its neighbour renders an empty string.
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
 * YYYY-MM-DD in UTC — the day a usage row is keyed by. The writer (the usage
 * repository's atomic ADD) and the readers (the dashboard's date pickers) must
 * resolve the same instant to the same day, so both sides import it from here
 * rather than each spelling the truncation out.
 */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * True when `day` names a real UTC calendar day, `YYYY-MM-DD`. The shape check
 * alone is not the calendar one: `2026-13-01` parses to NaN, and `2026-02-31`
 * parses — to March 3rd, silently widening whatever range it bounds.
 * Round-tripping through {@link utcDay} rejects both. Every reader that
 * accepts a day from outside validates through this, so three of them cannot
 * disagree about which days exist — two of the three already did.
 */
export function isUtcDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return false;
  }
  const at = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(at) && utcDay(new Date(at)) === day;
}

/** YYYY-MM in UTC — the month a monthly cost window is keyed by. */
export function utcMonth(date: Date): string {
  return date.toISOString().slice(0, 7);
}


/**
 * A run's wall clock for a system prompt — `2026-07-30 (Thursday) 06:12 UTC`.
 *
 * UTC, and labelled as such. A model that knows the zone can convert; an
 * unlabelled local time is worse than no time at all, because it reads as
 * authoritative while being wrong for most readers. Displaying an operator's
 * timezone instead would mean a new setting, and nothing yet asks for one.
 *
 * The weekday is spelled out because deriving it from a date is exactly the
 * arithmetic a model gets wrong, and relative dates ("last Tuesday", "this
 * Friday") are resolved from it. Minute precision: a prompt that changed every
 * second would defeat provider prompt caching for no gain.
 */
export function formatRunClock(date: Date): string {
  const iso = date.toISOString();
  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: "UTC",
  }).format(date);
  return `${iso.slice(0, 10)} (${weekday}) ${iso.slice(11, 16)} UTC`;
}
