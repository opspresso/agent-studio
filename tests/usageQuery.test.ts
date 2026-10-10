import { describe, expect, it } from "vitest";
import { readUsageQuery, writeUsageQuery } from "@/app/_lib/usageQuery";

const defaults = { from: "2026-10-01", to: "2026-10-09" };
describe("usage URL state", () => {
  it("round-trips the exact scope, axis, dates and metric", () => {
    const expected = { range: defaults, model: "provider/a.b", user: "user+one", groupBy: "provider" as const, metric: "tokensPerSecond" as const };
    const query = writeUsageQuery(expected, "other=kept&model=old");
    expect(readUsageQuery(new URLSearchParams(query), true, { from: "later", to: "later" })).toEqual(expected);
    expect(new URLSearchParams(query).get("other")).toBe("kept");
  });
  it("removes cleared filters and rejects unsupported group and metric names", () => {
    const value = readUsageQuery(new URLSearchParams("group=department&metric=constructor&user=one"), false, defaults);
    expect(value).toEqual({ range: defaults, model: null, user: null, groupBy: "model", metric: "cost" });
    expect(writeUsageQuery(value, "user=one&model=old")).not.toMatch(/user=|model=/);
  });
  it("keeps incomplete dates visible to the existing API validation", () => {
    expect(readUsageQuery(new URLSearchParams("from=&to=invalid"), true, defaults).range).toEqual({ from: "", to: "invalid" });
  });
});
