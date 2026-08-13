import { describe, expect, it } from "vitest";
import { listMemberMonths } from "@/application/usage/usageUseCases";
import type { UsageRepository } from "@/domain/usage/repository";
import type { MemberMonthlyUsageRow } from "@/domain/usage/types";

const now = new Date("2026-02-10T12:00:00Z");

function usageWith(rows: Record<string, MemberMonthlyUsageRow>, asked: string[]): UsageRepository {
  return {
    record: async () => {},
    getDay: async () => null,
    async getMemberMonth(_email, month) {
      asked.push(month);
      return rows[month] ?? null;
    },
    claimAlert: async () => false,
    claimMonthAlert: async () => false,
    listActorsByProject: async () => [],
    listByProject: async () => [],
    listByDateRange: async () => [],
  };
}

describe("listMemberMonths", () => {
  it("asks for exactly the recent months, newest first, and zero-fills the gaps", async () => {
    const asked: string[] = [];
    const january: MemberMonthlyUsageRow = {
      email: "u@x.com",
      month: "2026-01",
      calls: { m: 3 },
      inputTokens: { m: 30 },
      outputTokens: { m: 15 },
      costUsd: { m: 1.5 },
    };
    const usage = usageWith({ "2026-01": january }, asked);

    const months = await listMemberMonths(usage, "u@x.com", 3, now);

    expect(asked).toEqual(["2026-02", "2026-01", "2025-12"]);
    expect(months.map((row) => row.month)).toEqual(["2026-02", "2026-01", "2025-12"]);
    expect(months[1]).toEqual(january);
    // Absent months come back as the member's own zero row, never null: the
    // client renders months[0] as the current month without date arithmetic.
    expect(months[0]).toEqual({
      email: "u@x.com",
      month: "2026-02",
      calls: {},
      inputTokens: {},
      outputTokens: {},
      costUsd: {},
    });
    expect(months[2]?.month).toBe("2025-12");
    expect(months[2]?.costUsd).toEqual({});
  });
});
