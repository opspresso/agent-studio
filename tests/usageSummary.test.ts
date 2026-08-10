import { describe, expect, it } from "vitest";
import type { UsageRow } from "@/domain/usage/types";
import {
  buildDailySeries,
  DAILY_SERIES_LIMIT,
  groupUsage,
  OTHERS_KEY,
  providerOf,
  toChartColumns,
  toChartData,
  totalCalls,
  totalCost,
} from "@/app/_lib/usage";
import { inclusiveDays, summaryQuerySchema } from "@/app/api/usages/summary/validation";

const rows: UsageRow[] = [
  {
    projectName: "alpha",
    date: "2026-01-01",
    calls: { "google/gemini-3.1-flash-lite": 10, "openai/gpt-5-mini": 4 },
    inputTokens: { "google/gemini-3.1-flash-lite": 1000, "openai/gpt-5-mini": 400 },
    outputTokens: { "google/gemini-3.1-flash-lite": 500, "openai/gpt-5-mini": 200 },
    costUsd: { "google/gemini-3.1-flash-lite": 0.2, "openai/gpt-5-mini": 0.8 },
  },
  {
    projectName: "beta",
    date: "2026-01-01",
    calls: { "openai/gpt-5-mini": 6 },
    inputTokens: { "openai/gpt-5-mini": 600 },
    outputTokens: { "openai/gpt-5-mini": 300 },
    costUsd: { "openai/gpt-5-mini": 1.2 },
  },
];

describe("providerOf", () => {
  it("returns the prefix before the first slash", () => {
    expect(providerOf("google/gemini-3.1-flash-lite")).toBe("google");
  });

  it("returns the whole id when there is no slash", () => {
    expect(providerOf("gemma")).toBe("gemma");
  });
});

describe("totals", () => {
  it("sums cost and calls across all rows and models", () => {
    expect(totalCost(rows)).toBeCloseTo(2.2, 6);
    expect(totalCalls(rows)).toBe(20);
  });
});

describe("groupUsage", () => {
  it("groups by project, sorted by cost desc", () => {
    expect(groupUsage(rows, "project")).toEqual([
      { key: "beta", cost: 1.2, calls: 6 },
      { key: "alpha", cost: 1, calls: 14 },
    ]);
  });

  it("groups by provider, folding model ids by prefix", () => {
    expect(groupUsage(rows, "provider")).toEqual([
      { key: "openai", cost: 2, calls: 10 },
      { key: "google", cost: 0.2, calls: 10 },
    ]);
  });

  it("groups by model across rows", () => {
    expect(groupUsage(rows, "model")).toEqual([
      { key: "openai/gpt-5-mini", cost: 2, calls: 10 },
      { key: "google/gemini-3.1-flash-lite", cost: 0.2, calls: 10 },
    ]);
  });
});

describe("buildDailySeries", () => {
  it("buckets cost per day and groups by project", () => {
    const series = buildDailySeries(rows, "project", "2026-01-01", "2026-01-02");
    expect(series.keys).toEqual(["beta", "alpha"]);
    expect(series.data).toEqual([
      { date: "2026-01-01", beta: 1.2, alpha: 1 },
      { date: "2026-01-02", beta: 0, alpha: 0 },
    ]);
  });

  it("groups by provider, folding model ids by prefix", () => {
    const series = buildDailySeries(rows, "provider", "2026-01-01", "2026-01-01");
    expect(series.keys).toEqual(["openai", "google"]);
    expect(series.data).toEqual([{ date: "2026-01-01", openai: 2, google: 0.2 }]);
  });

  it("fills every date in range with zeros when there are no items", () => {
    const series = buildDailySeries([], "project", "2026-01-01", "2026-01-03");
    expect(series.keys).toEqual([]);
    expect(series.data.map((point) => point.date)).toEqual([
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
    ]);
  });

  it("folds series beyond the limit into Others", () => {
    const many: UsageRow[] = Array.from({ length: DAILY_SERIES_LIMIT + 2 }, (_, i) => ({
      projectName: `p${i}`,
      date: "2026-01-01",
      calls: { "openai/gpt-5-mini": 1 },
      inputTokens: { "openai/gpt-5-mini": 100 },
      outputTokens: { "openai/gpt-5-mini": 50 },
      costUsd: { "openai/gpt-5-mini": i + 1 },
    }));
    const series = buildDailySeries(many, "project", "2026-01-01", "2026-01-01");
    expect(series.keys).toHaveLength(DAILY_SERIES_LIMIT + 1);
    expect(series.keys[series.keys.length - 1]).toBe(OTHERS_KEY);
    // Keys keep the highest-cost projects; the two cheapest (1 + 2) fold into Others.
    expect(series.keys).not.toContain("p0");
    expect(series.keys).not.toContain("p1");
    expect(series.data[0]?.[OTHERS_KEY]).toBeCloseTo(3, 6);
  });

  it("returns empty data for a malformed range", () => {
    const series = buildDailySeries(rows, "project", "not-a-date", "2026-01-02");
    expect(series.data).toEqual([]);
  });
});

describe("toChartColumns / toChartData", () => {
  it("addresses a dotted model id by a dot-free key and keeps the id as the label", () => {
    const series = buildDailySeries(rows, "model", "2026-01-01", "2026-01-01");
    const columns = toChartColumns(series.keys);
    expect(columns.map((column) => column.label)).toEqual(series.keys);
    expect(columns.every((column) => !column.dataKey.includes("."))).toBe(true);
    const dotted = columns.find((column) => column.label === "google/gemini-3.1-flash-lite");
    expect(dotted).toBeDefined();
    expect(toChartData(series.data, columns)[0]?.[dotted!.dataKey]).toBeCloseTo(0.2, 6);
  });

  it("zero-fills a key the point does not carry", () => {
    const columns = toChartColumns(["a", "b"]);
    expect(toChartData([{ date: "2026-01-01", a: 3 }], columns)).toEqual([
      { date: "2026-01-01", s0: 3, s1: 0 },
    ]);
  });
});

describe("inclusiveDays", () => {
  it("counts both endpoints", () => {
    expect(inclusiveDays("2026-01-01", "2026-01-01")).toBe(1);
    expect(inclusiveDays("2026-01-01", "2026-01-02")).toBe(2);
    expect(inclusiveDays("2026-03-01", "2026-03-31")).toBe(31);
  });
});

describe("summaryQuerySchema", () => {
  it("accepts a valid range and leaves project optional", () => {
    const result = summaryQuerySchema.safeParse({ from: "2026-05-01", to: "2026-05-10" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.project).toBeUndefined();
    }
  });

  it("keeps an explicit project", () => {
    const result = summaryQuerySchema.safeParse({
      from: "2026-05-01",
      to: "2026-05-10",
      project: "alpha",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.project).toBe("alpha");
    }
  });

  it("rejects from after to", () => {
    const result = summaryQuerySchema.safeParse({ from: "2026-05-10", to: "2026-05-01" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("from must be on or before to");
    }
  });

  it("accepts exactly 184 days but rejects 185", () => {
    // 2026-01-01 .. 2026-07-03 spans 184 days inclusive; 2026-07-04 spans 185.
    expect(summaryQuerySchema.safeParse({ from: "2026-01-01", to: "2026-07-03" }).success).toBe(
      true,
    );
    const tooLong = summaryQuerySchema.safeParse({ from: "2026-01-01", to: "2026-07-04" });
    expect(tooLong.success).toBe(false);
    if (!tooLong.success) {
      expect(tooLong.error.issues[0]?.message).toBe("date range must be 184 days or less");
    }
  });

  it("rejects a malformed date", () => {
    const result = summaryQuerySchema.safeParse({ from: "05-10-2026", to: "2026-05-11" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("must be yyyy-MM-dd, naming a real UTC day");
    }
  });

  it("rejects a day the calendar does not have", () => {
    // A shape regex let 2026-02-31 through, and `inclusiveDays` read it as
    // March 3rd — a range the caller never asked about, answered `{items: []}`.
    const result = summaryQuerySchema.safeParse({ from: "2026-02-31", to: "2026-03-05" });
    expect(result.success).toBe(false);
  });
});
