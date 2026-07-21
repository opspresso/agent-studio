import { describe, expect, it } from "vitest";
import type { UsageRow } from "@/domain/usage/types";
import { groupUsage, providerOf, totalCalls, totalCost } from "@/app/dashboard/_lib/usage";
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
      expect(result.error.issues[0]?.message).toBe("must be yyyy-MM-dd");
    }
  });
});
