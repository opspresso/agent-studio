import { describe, expect, it } from "vitest";
import { dueSlots, isValidTimezone, parseCron } from "@/domain/trigger/cron";

/** Occurrences of `expr` in `(after, until]`, as ISO strings for readable diffs. */
function slots(expr: string, timeZone: string, after: string, until: string): string[] {
  const spec = parseCron(expr);
  if (!spec) {
    throw new Error(`expected "${expr}" to parse`);
  }
  return dueSlots(spec, timeZone, new Date(after), new Date(until)).map((d) => d.toISOString());
}

describe("parseCron", () => {
  it("accepts the standard forms", () => {
    for (const expr of [
      "* * * * *",
      "0 9 * * 1-5",
      "*/15 * * * *",
      "0,30 0-6 1,15 jan-mar sun",
      "30 4 1 * SAT",
      "5/10 * * * *",
    ]) {
      expect(parseCron(expr), expr).not.toBeNull();
    }
  });

  it("rejects what is not a five-field cron expression", () => {
    for (const expr of [
      "",
      "* * * *",
      "* * * * * *",
      "60 * * * *",
      "* 24 * * *",
      "* * 0 * *",
      "* * * 13 *",
      "* * * * 8",
      "*/0 * * * *",
      "5-1 * * * *",
      "a * * * *",
      "1,,2 * * * *",
      "1;2 * * * *",
    ]) {
      expect(parseCron(expr), expr).toBeNull();
    }
  });

  it("rejects Object.prototype members posing as month or weekday names", () => {
    // A plain object lookup would resolve these to functions, producing a spec
    // that parses fine and can never match — a silently dead schedule.
    for (const expr of [
      "0 9 * constructor *",
      "0 0 * * __proto__",
      "0 0 * hasOwnProperty *",
    ]) {
      expect(parseCron(expr), expr).toBeNull();
    }
  });
});

describe("dueSlots", () => {
  it("walks every minute boundary in the window", () => {
    expect(slots("* * * * *", "UTC", "2026-08-01T00:00:00Z", "2026-08-01T00:05:00Z")).toEqual([
      "2026-08-01T00:01:00.000Z",
      "2026-08-01T00:02:00.000Z",
      "2026-08-01T00:03:00.000Z",
      "2026-08-01T00:04:00.000Z",
      "2026-08-01T00:05:00.000Z",
    ]);
  });

  it("excludes `after` and includes `until` — a shared boundary belongs to one window", () => {
    const at = "2026-08-01T00:01:00.000Z";
    expect(slots("* * * * *", "UTC", "2026-08-01T00:00:00Z", at)).toContain(at);
    expect(slots("* * * * *", "UTC", at, "2026-08-01T00:02:00Z")).not.toContain(at);
  });

  it("starts from the first whole minute after a mid-minute `after`", () => {
    expect(slots("* * * * *", "UTC", "2026-08-01T00:00:30.500Z", "2026-08-01T00:01:10Z")).toEqual([
      "2026-08-01T00:01:00.000Z",
    ]);
  });

  it("reads the fields in the trigger's timezone", () => {
    // 09:30 in Seoul is 00:30 UTC.
    expect(slots("30 9 * * *", "Asia/Seoul", "2026-08-01T00:00:00Z", "2026-08-01T01:00:00Z")).toEqual([
      "2026-08-01T00:30:00.000Z",
    ]);
    expect(slots("30 9 * * *", "UTC", "2026-08-01T00:00:00Z", "2026-08-01T01:00:00Z")).toEqual([]);
  });

  it("reads the weekday in the trigger's timezone too", () => {
    // 2026-08-01T13:00Z is Saturday in UTC but already 01:00 Sunday in Auckland.
    expect(
      slots("0 1 * * 0", "Pacific/Auckland", "2026-08-01T12:00:00Z", "2026-08-01T13:30:00Z"),
    ).toEqual(["2026-08-01T13:00:00.000Z"]);
    expect(slots("0 1 * * 6", "Pacific/Auckland", "2026-08-01T12:00:00Z", "2026-08-01T13:30:00Z")).toEqual([]);
  });

  it("treats 7 as Sunday", () => {
    // 2026-08-02 is a Sunday.
    expect(slots("0 0 * * 7", "UTC", "2026-08-01T23:59:00Z", "2026-08-02T00:01:00Z")).toEqual([
      "2026-08-02T00:00:00.000Z",
    ]);
  });

  it("matches restricted day-of-month OR day-of-week, the classic quirk", () => {
    const expr = "0 0 13 * 5";
    // 2026-08-13 is a Thursday — fires on the day-of-month alone.
    expect(slots(expr, "UTC", "2026-08-12T23:59:00Z", "2026-08-13T00:01:00Z")).toEqual([
      "2026-08-13T00:00:00.000Z",
    ]);
    // 2026-08-14 is a Friday — fires on the weekday alone.
    expect(slots(expr, "UTC", "2026-08-13T23:59:00Z", "2026-08-14T00:01:00Z")).toEqual([
      "2026-08-14T00:00:00.000Z",
    ]);
    // 2026-08-12 is a Wednesday and not the 13th.
    expect(slots(expr, "UTC", "2026-08-11T23:59:00Z", "2026-08-12T00:01:00Z")).toEqual([]);
  });

  it("requires both day fields only when just one is restricted", () => {
    // Day-of-month alone: Fridays do not fire.
    expect(slots("0 0 13 * *", "UTC", "2026-08-13T23:59:00Z", "2026-08-14T00:01:00Z")).toEqual([]);
    // Day-of-week alone: the 13th does not fire.
    expect(slots("0 0 * * 5", "UTC", "2026-08-12T23:59:00Z", "2026-08-13T00:01:00Z")).toEqual([]);
  });

  it("reads a full-range day field as unrestricted, not as the OR quirk's trigger", () => {
    // `*/1` in day-of-week covers every weekday; treated as restricted it would
    // turn "the 1st of the month" into "every day" — ~30x the intended runs.
    expect(slots("0 0 1 * */1", "UTC", "2026-08-01T23:59:00Z", "2026-08-03T00:01:00Z")).toEqual(
      [],
    );
    expect(slots("0 0 1 * */1", "UTC", "2026-08-31T23:59:00Z", "2026-09-01T00:01:00Z")).toEqual([
      "2026-09-01T00:00:00.000Z",
    ]);
    // The mirror image: a full-range day-of-month must not defeat "weekdays
    // only". 2026-08-01 is a Saturday.
    expect(slots("0 9 */1 * 1-5", "UTC", "2026-08-01T08:59:00Z", "2026-08-01T09:01:00Z")).toEqual(
      [],
    );
    // `0-7` in day-of-week is every day too, once 7 folds into Sunday.
    expect(slots("0 0 13 * 0-7", "UTC", "2026-08-12T23:59:00Z", "2026-08-13T00:01:00Z")).toEqual([
      "2026-08-13T00:00:00.000Z",
    ]);
  });

  it("fires a fall-back wall-clock time once per UTC instant — twice that night", () => {
    // DST ends 2026-11-01 in New York: 01:30 exists at 05:30Z (EDT) and again
    // at 06:30Z (EST). Occurrences are keyed by instant, so both fire.
    expect(slots("30 1 * * *", "America/New_York", "2026-11-01T04:00:00Z", "2026-11-01T07:00:00Z")).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T06:30:00.000Z",
    ]);
  });

  it("never fires a wall-clock time spring-forward skips", () => {
    // DST starts 2026-03-08 in New York: 02:00–03:00 does not exist that day.
    expect(slots("30 2 * * *", "America/New_York", "2026-03-08T05:00:00Z", "2026-03-08T09:00:00Z")).toEqual(
      [],
    );
  });
});

describe("isValidTimezone", () => {
  it("accepts what Intl can resolve and refuses the rest", () => {
    expect(isValidTimezone("Asia/Seoul")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Not/AZone")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });
});
