/**
 * Cron evaluation for schedule triggers — the single owner of "when does this
 * schedule fire".
 *
 * Five standard fields (minute hour day-of-month month day-of-week) with `*`,
 * lists, ranges and steps; three-letter names for month and weekday;
 * day-of-week 0–7 where both 0 and 7 are Sunday; the classic quirk that a
 * restricted day-of-month and a restricted day-of-week match as *either*, not
 * both.
 *
 * An occurrence is a UTC minute boundary whose *wall clock* in the trigger's
 * timezone matches the fields. Keying occurrences by UTC instant settles the
 * DST cases without special-casing them: a wall-clock time skipped by
 * spring-forward has no matching instant that day, and one repeated by
 * fall-back has two — each its own occurrence, each claimed separately.
 */

/** Allowed values for one field, or `"any"` for a bare `*` (unrestricted). */
type CronField = ReadonlySet<number> | "any";

export interface CronSpec {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  /** Normalised to 0–6; a written `7` becomes `0` at parse time. */
  dayOfWeek: CronField;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function parseValue(raw: string, names?: Record<string, number>): number | null {
  if (names) {
    const lower = raw.toLowerCase();
    // Own keys only: a plain lookup would find Object.prototype's members, and
    // "constructor" as a month must be a parse error, not a spec that can
    // never match.
    if (Object.hasOwn(names, lower)) {
      return names[lower] ?? null;
    }
  }
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

/**
 * One field: comma-separated parts, each `*`, `a`, `a-b`, optionally `/step`
 * (`a/step` runs to the field's max, as in Vixie cron). Grammar, not a config
 * list, which is why this does not go through `parseList` — and could not:
 * domain code imports nothing.
 */
function parseField(
  raw: string,
  min: number,
  max: number,
  names?: Record<string, number>,
): CronField | null {
  if (raw === "*") {
    return "any";
  }
  const values = new Set<number>();
  for (const part of raw.split(/,/)) {
    let body = part;
    let step = 1;
    const slash = body.indexOf("/");
    if (slash >= 0) {
      const stepRaw = body.slice(slash + 1);
      if (!/^\d+$/.test(stepRaw) || Number(stepRaw) < 1) {
        return null;
      }
      step = Number(stepRaw);
      body = body.slice(0, slash);
    }
    let from: number;
    let to: number;
    if (body === "*") {
      from = min;
      to = max;
    } else {
      const dash = body.indexOf("-");
      if (dash > 0) {
        const a = parseValue(body.slice(0, dash), names);
        const b = parseValue(body.slice(dash + 1), names);
        if (a === null || b === null) {
          return null;
        }
        from = a;
        to = b;
      } else {
        const a = parseValue(body, names);
        if (a === null) {
          return null;
        }
        from = a;
        to = slash >= 0 ? max : a;
      }
    }
    if (from < min || to > max || from > to) {
      return null;
    }
    for (let value = from; value <= to; value += step) {
      values.add(value);
    }
  }
  return values;
}

/** Both 0 and 7 mean Sunday; store only 0 so matching never has to know. */
function normalizeSunday(field: CronField): CronField {
  if (field === "any" || !field.has(7)) {
    return field;
  }
  const values = new Set(field);
  values.delete(7);
  values.add(0);
  return values;
}

// A set that allows every value the field can take is `*` in disguise, and the
// dom/dow OR quirk must not read it as a restriction: `0 0 1 * */1` means "the
// 1st of the month", not "every day" — which is what a restricted-looking
// full-range day-of-week would turn it into.
function fullRangeAsAny(field: CronField, min: number, max: number): CronField {
  if (field === "any") {
    return field;
  }
  for (let value = min; value <= max; value += 1) {
    if (!field.has(value)) {
      return field;
    }
  }
  return "any";
}

/** Parse a five-field cron expression, or say it is not one. */
export function parseCron(expr: string): CronSpec | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return null;
  }
  const [minuteRaw = "", hourRaw = "", domRaw = "", monthRaw = "", dowRaw = ""] = fields;
  const minute = parseField(minuteRaw, 0, 59);
  const hour = parseField(hourRaw, 0, 23);
  const dayOfMonth = parseField(domRaw, 1, 31);
  const month = parseField(monthRaw, 1, 12, MONTH_NAMES);
  const dayOfWeek = parseField(dowRaw, 0, 7, DOW_NAMES);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    return null;
  }
  return {
    minute: fullRangeAsAny(minute, 0, 59),
    hour: fullRangeAsAny(hour, 0, 23),
    dayOfMonth: fullRangeAsAny(dayOfMonth, 1, 31),
    month: fullRangeAsAny(month, 1, 12),
    // Sunday first: `0-7` covers the effective 0–6 domain only once 7 folds in.
    dayOfWeek: fullRangeAsAny(normalizeSunday(dayOfWeek), 0, 6),
  };
}

/** Whatever `Intl` can resolve — which is the resolver `dueSlots` will use. */
export function isValidTimezone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Formatters are expensive to build and the scan asks per minute per trigger. */
const formatters = new Map<string, Intl.DateTimeFormat>();

/** More zones than exist; bounds the cache against arbitrary key strings. */
const MAX_FORMATTERS = 500;

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) {
    return cached;
  }
  if (formatters.size >= MAX_FORMATTERS) {
    formatters.clear();
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    minute: "numeric",
    second: "numeric",
    year: "numeric",
    hour: "numeric",
    day: "numeric",
    month: "numeric",
    weekday: "short",
  });
  formatters.set(timeZone, formatter);
  return formatter;
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

interface WallClock {
  year: number;
  second: number;
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
}

/** What a clock on the wall in `timeZone` shows at this UTC instant. */
export function wallClock(instant: Date, timeZone: string): WallClock {
  const read: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of formatterFor(timeZone).formatToParts(instant)) {
    read[part.type] = part.value;
  }
  return {
    minute: Number(read.minute),
    year: Number(read.year),
    second: Number(read.second),
    // `% 24` guards the ICU quirk where midnight renders as "24" — `h23`
    // requests 0–23, but a wrong 24 here would silently skip every midnight.
    hour: Number(read.hour) % 24,
    dayOfMonth: Number(read.day),
    month: Number(read.month),
    dayOfWeek: WEEKDAYS[read.weekday ?? ""] ?? -1,
  };
}

function fieldMatches(field: CronField, value: number): boolean {
  return field === "any" || field.has(value);
}

function cronMatches(spec: CronSpec, clock: WallClock): boolean {
  if (
    !fieldMatches(spec.minute, clock.minute) ||
    !fieldMatches(spec.hour, clock.hour) ||
    !fieldMatches(spec.month, clock.month)
  ) {
    return false;
  }
  // The standard quirk: when *both* day fields are restricted, matching either
  // is enough — "0 0 13 * 5" is the 13th and every Friday, not Friday the 13th.
  const domRestricted = spec.dayOfMonth !== "any";
  const dowRestricted = spec.dayOfWeek !== "any";
  if (domRestricted && dowRestricted) {
    return (
      fieldMatches(spec.dayOfMonth, clock.dayOfMonth) ||
      fieldMatches(spec.dayOfWeek, clock.dayOfWeek)
    );
  }
  return (
    fieldMatches(spec.dayOfMonth, clock.dayOfMonth) &&
    fieldMatches(spec.dayOfWeek, clock.dayOfWeek)
  );
}

const MINUTE_MS = 60_000;

/**
 * The occurrences of `spec` in `timeZone` within `(after, until]`.
 *
 * Half-open on purpose: back-to-back scan windows share a boundary, and it must
 * belong to exactly one of them. The caller keeps the window minutes wide, so
 * walking the boundaries one by one is a handful of `Intl` reads, not a search.
 */
export function dueSlots(spec: CronSpec, timeZone: string, after: Date, until: Date): Date[] {
  const slots: Date[] = [];
  for (
    let t = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
    t <= until.getTime();
    t += MINUTE_MS
  ) {
    const instant = new Date(t);
    if (cronMatches(spec, wallClock(instant, timeZone))) {
      slots.push(instant);
    }
  }
  return slots;
}
