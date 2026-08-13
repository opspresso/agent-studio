import { describe, expect, it } from "vitest";
import { listMemberUsage } from "@/application/usage/usageUseCases";
import type { UsageRepository } from "@/domain/usage/repository";
import type { MemberUsageRow } from "@/domain/usage/types";

const row: MemberUsageRow = {
  email: "u@x.com",
  projectName: "p",
  date: "2026-02-10",
  calls: { m: 3 },
  inputTokens: { m: 30 },
  outputTokens: { m: 15 },
  costUsd: { m: 1.5 },
};

function usageWith(asked: Array<[string, string, string]>): UsageRepository {
  return {
    record: async () => {},
    getDay: async () => null,
    async listMemberDays(email, from, to) {
      asked.push([email, from, to]);
      return [row];
    },
    claimAlert: async () => false,
    claimMonthAlert: async () => false,
    listActorsByProject: async () => [],
    listByProject: async () => [],
    listByDateRange: async () => [],
  };
}

describe("listMemberUsage", () => {
  it("passes the caller's own email and window straight through", async () => {
    const asked: Array<[string, string, string]> = [];

    await expect(
      listMemberUsage(usageWith(asked), "u@x.com", "2026-02-01", "2026-02-28"),
    ).resolves.toEqual([row]);
    expect(asked).toEqual([["u@x.com", "2026-02-01", "2026-02-28"]]);
  });
});
