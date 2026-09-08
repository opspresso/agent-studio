import type { FileRetention } from "@/domain/artifact/retention";
import { wallClock } from "@/domain/trigger/cron";
import { isUtcDay } from "@/shared/date";

/** Calendar retention preserves wall time, clamps month ends, and never reads the clock. */
export function fileExpiresAt(storedAt: string, retention: FileRetention): string {
  if (!Number.isSafeInteger(retention.value) || retention.value <= 0 ||
    !["days", "months"].includes(retention.unit) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(storedAt)) {
    throw new Error("File retention requires an instant and a positive calendar duration");
  }
  const instant = new Date(storedAt);
  if (!Number.isFinite(instant.getTime()) || !isUtcDay(storedAt.slice(0, 10)) ||
    Number(storedAt.slice(11, 13)) > 23 || storedAt.startsWith("0000-") || !retention.timezone) {
    throw new Error("File retention instant or timezone is invalid");
  }
  const wallMillis = (at: number): number => {
    const parts = wallClock(new Date(at), retention.timezone);
    const wall = new Date(0);
    wall.setUTCFullYear(parts.year, parts.month - 1, parts.dayOfMonth);
    wall.setUTCHours(parts.hour, parts.minute, parts.second, new Date(at).getUTCMilliseconds());
    return wall.getTime();
  };
  const target = new Date(wallMillis(instant.getTime()));
  if (retention.unit === "months") {
    const day = target.getUTCDate();
    target.setUTCDate(1);
    target.setUTCMonth(target.getUTCMonth() + retention.value);
    const lastDay = new Date(target);
    lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
    target.setUTCDate(Math.min(day, lastDay.getUTCDate()));
  } else {
    target.setUTCDate(target.getUTCDate() + retention.value);
  }
  const desired = target.getTime();
  if (!Number.isFinite(desired)) throw new Error("File retention exceeds the supported date range");

  // Nearby offsets cover both sides of a timezone transition, including a skipped day.
  // A fold chooses the earlier instant; a gap moves forward by the offset change.
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 12) {
    const probe = desired + hours * 3_600_000;
    offsets.add(wallMillis(probe) - probe);
  }
  const candidates = [...offsets].map((offset) => desired - offset);
  const exact = candidates.filter((at) => wallMillis(at) === desired);
  const later = candidates.filter((at) => wallMillis(at) > desired);
  const expires = exact.length ? Math.min(...exact) : Math.min(...later);
  if (!Number.isFinite(expires) || expires <= instant.getTime()) {
    throw new Error("File retention could not resolve a future expiration");
  }
  return new Date(expires).toISOString();
}
