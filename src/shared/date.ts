/** Compact date-time for chat bubbles (e.g. "7/23 14:32"). Empty string for missing/invalid input. */
export function formatShortDateTime(iso: string): string {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Full locale date-time (year included). Empty string for missing/invalid input. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString();
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
