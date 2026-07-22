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
