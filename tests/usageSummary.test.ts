import { describe, expect, it } from "vitest";
import type { UsageRow } from "@/domain/usage/types";
import {
  buildDailySeries,
  filterUsage,
  totalUsage,
  usageMetricValue,
  MAX_CHART_SERIES,
  groupUsage,
  OTHERS_KEY,
  providerOf,
  toChartColumns,
  toChartData,
  totalCalls,
  totalCost,
  type DailyCostRow,
} from "@/app/_lib/usage";
import { summaryQuerySchema } from "@/app/api/usages/summary/validation";

const rows: UsageRow[] = [
  {
    agentName: "alpha",
    date: "2026-01-01",
    calls: { "google/gemini-3.1-flash-lite": 10, "openai/gpt-5-mini": 4 },
    inputTokens: { "google/gemini-3.1-flash-lite": 1000, "openai/gpt-5-mini": 400 },
    outputTokens: { "google/gemini-3.1-flash-lite": 500, "openai/gpt-5-mini": 200 },
    costUsd: { "google/gemini-3.1-flash-lite": 0.2, "openai/gpt-5-mini": 0.8 },
  },
  {
    agentName: "beta",
    date: "2026-01-01",
    calls: { "openai/gpt-5-mini": 6 },
    inputTokens: { "openai/gpt-5-mini": 600 },
    outputTokens: { "openai/gpt-5-mini": 300 },
    cachedTokens: { "openai/gpt-5-mini": 480 },
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

const unmeasured = { modelDurationMs: 0, timedOutputTokens: 0, timedCalls: 0 };

describe("groupUsage", () => {
  it("groups by agent, sorted by cost desc", () => {
    expect(groupUsage(rows, "agent")).toEqual([
      { key: "beta", cost: 1.2, calls: 6, inputTokens: 600, outputTokens: 300, cachedTokens: 480, ...unmeasured },
      { key: "alpha", cost: 1, calls: 14, inputTokens: 1400, outputTokens: 700, cachedTokens: 0, ...unmeasured },
    ]);
  });

  it("groups by provider, folding model ids by prefix", () => {
    expect(groupUsage(rows, "provider")).toEqual([
      { key: "openai", cost: 2, calls: 10, inputTokens: 1000, outputTokens: 500, cachedTokens: 480, ...unmeasured },
      { key: "google", cost: 0.2, calls: 10, inputTokens: 1000, outputTokens: 500, cachedTokens: 0, ...unmeasured },
    ]);
  });

  it("groups by model across rows", () => {
    expect(groupUsage(rows, "model")).toEqual([
      { key: "openai/gpt-5-mini", cost: 2, calls: 10, inputTokens: 1000, outputTokens: 500, cachedTokens: 480, ...unmeasured },
      {
        key: "google/gemini-3.1-flash-lite",
        cost: 0.2,
        calls: 10,
        inputTokens: 1000,
        cachedTokens: 0, outputTokens: 500, ...unmeasured,
      },
    ]);
  });

  it("reads a day recorded before cached tokens existed as none, not as a cold cache", () => {
    // Rows written before the field carry no map at all, and a row summing to
    // zero cached tokens is what the breakdown renders as blank rather than 0%.
    const legacy: DailyCostRow[] = [
      { agentName: "alpha", date: "2026-01-01", calls: { m: 1 }, costUsd: { m: 1 } },
    ];
    expect(groupUsage(legacy, "agent")).toEqual([
      { key: "alpha", cost: 1, calls: 1, inputTokens: 0, outputTokens: 0, cachedTokens: 0, ...unmeasured },
    ]);
  });

  it("groups a member's own rows the same three ways", () => {
    // This minimal projection omits token maps but retains the Agent axis.
    const mine: DailyCostRow[] = [
      { agentName: "alpha", date: "2026-01-01", calls: { "openai/gpt-5-mini": 2 }, costUsd: { "openai/gpt-5-mini": 1 } },
      { agentName: "beta", date: "2026-01-01", calls: { "google/gemini-3.1-flash-lite": 1 }, costUsd: { "google/gemini-3.1-flash-lite": 3 } },
    ];
    expect(groupUsage(mine, "agent")).toEqual([
      { key: "beta", cost: 3, calls: 1, inputTokens: 0, outputTokens: 0, cachedTokens: 0, ...unmeasured },
      { key: "alpha", cost: 1, calls: 2, inputTokens: 0, outputTokens: 0, cachedTokens: 0, ...unmeasured },
    ]);
    expect(groupUsage(mine, "provider").map((g) => g.key)).toEqual(["google", "openai"]);
    expect(groupUsage(mine, "model").map((g) => g.key)).toEqual([
      "google/gemini-3.1-flash-lite",
      "openai/gpt-5-mini",
    ]);
  });
});

describe("buildDailySeries", () => {
  it("plots free model calls and output even when the cost chart is empty", () => {
    const free = [{ date: "2026-01-01", calls: { free: 2 }, outputTokens: { free: 100 }, costUsd: { free: 0 } }];
    expect(buildDailySeries(free, "model", "2026-01-01", "2026-01-02").keys).toEqual([]);
    expect(buildDailySeries(free, "model", "2026-01-01", "2026-01-02", undefined, "outputTokens")).toEqual({
      keys: ["free"], data: [{ date: "2026-01-01", values: [100] }, { date: "2026-01-02", values: [0] }],
    });
  });

  it("weights measured output across calls and leaves missing dates null", () => {
    const measured = [
      { date: "2026-01-01", userId: "u", calls: { m: 2 }, outputTokens: { m: 1000 }, costUsd: { m: 0 },
        timedOutputTokens: { m: 100 }, timedCalls: { m: 1 }, modelDurationMs: { m: 1000 } },
      { date: "2026-01-01", userId: "u", calls: { m: 1 }, outputTokens: { m: 100 }, costUsd: { m: 0 },
        timedOutputTokens: { m: 100 }, timedCalls: { m: 1 }, modelDurationMs: { m: 3000 } },
    ];
    expect(usageMetricValue(totalUsage(measured), "tokensPerSecond")).toBe(50);
    const series = buildDailySeries(measured, "user", "2026-01-01", "2026-01-02", undefined, "tokensPerSecond");
    expect(series).toEqual({ keys: ["u"], data: [{ date: "2026-01-01", values: [50] }, { date: "2026-01-02", values: [null] }] });
    expect(toChartData(series.data, toChartColumns(series.keys))[1]?.s0).toBeNull();
  });

  it("weights the Others throughput instead of adding model speeds", () => {
    const measured = Array.from({ length: 10 }, (_, i) => ({ date: "2026-01-01", calls: { [`m${i}`]: 1 }, costUsd: { [`m${i}`]: 0 },
      timedOutputTokens: { [`m${i}`]: 100 }, timedCalls: { [`m${i}`]: 1 }, modelDurationMs: { [`m${i}`]: 1000 * (i + 1) } }));
    const series = buildDailySeries(measured, "model", "2026-01-01", "2026-01-01", undefined, "tokensPerSecond");
    expect(series.keys.at(-1)).toBe(OTHERS_KEY);
    expect(series.data[0]?.values.at(-1)).toBeCloseTo(200 / 19);
  });

  it("filters every counter by user and model without mutating source rows", () => {
    const source = [{ ...rows[0]!, userId: "u1", timedCalls: { "openai/gpt-5-mini": 2 },
      timedOutputTokens: { "openai/gpt-5-mini": 100 }, modelDurationMs: { "openai/gpt-5-mini": 2000 } }, { ...rows[1]!, userId: "u2" }];
    const filtered = filterUsage(source, "openai/gpt-5-mini", "u1");
    expect(filtered).toHaveLength(1);
    expect(totalUsage(filtered)).toMatchObject({ cost: 0.8, calls: 4, inputTokens: 400, outputTokens: 200, timedCalls: 2 });
    expect(usageMetricValue(totalUsage(filtered), "tokensPerSecond")).toBe(50);
    expect(Object.keys(source[0]!.calls)).toHaveLength(2);
  });
  it.each([
    ["2026-01-01", "2026-07-04"],
    ["0001-01-01", "9999-12-31"],
    ["2026-02-31", "2026-03-05"],
  ])("does not enumerate dates rejected by the query contract: %s .. %s", (from, to) => {
    expect(summaryQuerySchema.safeParse({ from, to }).success).toBe(false);
    expect(buildDailySeries(rows, "agent", from, to).data).toEqual([]);
  });

  it("renders the complete maximum query window", () => {
    const series = buildDailySeries(rows, "agent", "2026-01-01", "2026-07-03");
    expect(series.data).toHaveLength(184);
    expect(series.data.at(-1)?.date).toBe("2026-07-03");
    expect(series.data[0]?.values).toEqual([1.2, 1]);
  });

  it("buckets cost per day and groups by agent", () => {
    const series = buildDailySeries(rows, "agent", "2026-01-01", "2026-01-02");
    expect(series.keys).toEqual(["beta", "alpha"]);
    expect(series.data).toEqual([
      { date: "2026-01-01", values: [1.2, 1] },
      { date: "2026-01-02", values: [0, 0] },
    ]);
  });

  it("groups by provider, folding model ids by prefix", () => {
    const series = buildDailySeries(rows, "provider", "2026-01-01", "2026-01-01");
    expect(series.keys).toEqual(["openai", "google"]);
    expect(series.data).toEqual([{ date: "2026-01-01", values: [2, 0.2] }]);
  });

  it("fills every date in range with zeros when there are no items", () => {
    const series = buildDailySeries([], "agent", "2026-01-01", "2026-01-03");
    expect(series.keys).toEqual([]);
    expect(series.data.map((point) => point.date)).toEqual([
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
    ]);
  });

  it("folds series beyond the limit into Others", () => {
    const many: UsageRow[] = Array.from({ length: MAX_CHART_SERIES + 2 }, (_, i) => ({
      agentName: `p${i}`,
      date: "2026-01-01",
      calls: { "openai/gpt-5-mini": 1 },
      inputTokens: { "openai/gpt-5-mini": 100 },
      outputTokens: { "openai/gpt-5-mini": 50 },
      costUsd: { "openai/gpt-5-mini": i + 1 },
    }));
    const series = buildDailySeries(many, "agent", "2026-01-01", "2026-01-01");
    expect(series.keys).toHaveLength(MAX_CHART_SERIES + 1);
    expect(series.keys[series.keys.length - 1]).toBe(OTHERS_KEY);
    // Keys keep the highest-cost agents; the two cheapest (1 + 2) fold into Others.
    expect(series.keys).not.toContain("p0");
    expect(series.keys).not.toContain("p1");
    expect(series.data[0]?.values.at(-1)).toBeCloseTo(3, 6);
  });

  it("returns empty data for a malformed range", () => {
    const series = buildDailySeries(rows, "agent", "not-a-date", "2026-01-02");
    expect(series.data).toEqual([]);
  });
});

describe("toChartColumns / toChartData", () => {
  it("preserves chart dates when an agent is named date", () => {
    const series = buildDailySeries([
      { agentName: "date", date: "2026-01-01", calls: { m: 1 }, costUsd: { m: 3 } },
    ], "agent", "2026-01-01", "2026-01-02");
    const columns = toChartColumns(series.keys);
    expect(columns.map((column) => column.label)).toEqual(["date"]);
    expect(toChartData(series.data, columns)).toEqual([
      { date: "2026-01-01", s0: 3 },
      { date: "2026-01-02", s0: 0 },
    ]);
  });

  it("preserves spend attributed to a department named __proto__", () => {
    const series = buildDailySeries([
      { agentName: "alpha", date: "2026-01-01", calls: { m: 1 }, costUsd: { m: 3 } },
    ], "department", "2026-01-01", "2026-01-01", new Map([["alpha", "__proto__"]]));
    const columns = toChartColumns(series.keys);
    expect(columns.map((column) => column.label)).toEqual(["__proto__"]);
    expect(toChartData(series.data, columns)).toEqual([{ date: "2026-01-01", s0: 3 }]);
  });

  it("keeps an Others department separate from the remaining departments' spend", () => {
    const many: DailyCostRow[] = Array.from({ length: MAX_CHART_SERIES + 2 }, (_, i) => ({
      agentName: `p${i}`,
      date: "2026-01-01",
      calls: { m: 1 },
      costUsd: { m: i + 1 },
    }));
    const departments = new Map(many.map((row, index) => [
      row.agentName!, index === many.length - 1 ? "Others" : `department-${index}`,
    ]));
    const series = buildDailySeries(many, "department", "2026-01-01", "2026-01-02", departments);
    const columns = toChartColumns(series.keys);
    const chartData = toChartData(series.data, columns);
    const others = columns.filter((column) => column.label === "Others");
    expect(columns).toHaveLength(MAX_CHART_SERIES + 1);
    expect(new Set(columns.map((column) => column.dataKey)).size).toBe(columns.length);
    expect(others).toHaveLength(2);
    expect(chartData[0]?.[others[0]!.dataKey]).toBe(10);
    expect(chartData[0]?.[others[1]!.dataKey]).toBe(3);
    expect(columns.reduce((sum, column) => sum + Number(chartData[0]?.[column.dataKey]), 0)).toBe(55);
    expect(columns.every((column) => chartData[1]?.[column.dataKey] === 0)).toBe(true);
    expect(chartData.map((point) => point.date)).toEqual(["2026-01-01", "2026-01-02"]);
  });

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
    expect(toChartData([{ date: "2026-01-01", values: [3] }], columns)).toEqual([
      { date: "2026-01-01", s0: 3, s1: 0 },
    ]);
  });

  it("preserves each column's spend when columns are reordered or filtered", () => {
    const series = buildDailySeries(rows, "agent", "2026-01-01", "2026-01-01");
    const columns = toChartColumns(series.keys);
    expect(toChartData(series.data, columns.toReversed())).toEqual([
      { date: "2026-01-01", s0: 1.2, s1: 1 },
    ]);
    expect(toChartData(series.data, columns.slice(1))).toEqual([
      { date: "2026-01-01", s1: 1 },
    ]);
  });
});

describe("summaryQuerySchema", () => {
  it("accepts a valid range and leaves agent optional", () => {
    const result = summaryQuerySchema.safeParse({ from: "2026-05-01", to: "2026-05-10" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agent).toBeUndefined();
    }
  });

  it("keeps an explicit agent", () => {
    const result = summaryQuerySchema.safeParse({
      from: "2026-05-01",
      to: "2026-05-10",
      agent: "alpha",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agent).toBe("alpha");
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
    // A shape regex let 2026-02-31 through, and the span arithmetic read it as
    // March 3rd — a range the caller never asked about, answered `{items: []}`.
    const result = summaryQuerySchema.safeParse({ from: "2026-02-31", to: "2026-03-05" });
    expect(result.success).toBe(false);
  });
});
