import { beforeEach, describe, expect, it, vi } from "vitest";
import { keys } from "@/infrastructure/db/keys";
import type { FakeStore } from "./fakeStore";

vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
const store = (await import("@/infrastructure/db/store")) as unknown as FakeStore;

const { PostgresUsageRepository } = await import(
  "@/infrastructure/db/repositories/usageRepository"
);

const NOW = Date.parse("2026-08-25T00:00:00Z");
const FRESH = Math.floor(NOW / 1000) + 86_400;

function counters() {
  return {
    calls: { m: 1 },
    inputTokens: {},
    outputTokens: {},
    cachedTokens: {},
    costUsd: {},
    expiresAt: FRESH,
  };
}

beforeEach(() => {
  store.rows.clear();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

describe("usage repository paging", () => {
  it("drains every primary-key usage read beyond one page", async () => {
    const days = Array.from({ length: 150 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10);
      return {
        ...keys.usage("p", date),
        entityType: "Usage",
        projectName: "p",
        date,
        ...counters(),
      };
    });
    const actors = Array.from({ length: 205 }, (_, index) => ({
      ...keys.usageActor("p", "2026-08-01", `user:${String(index).padStart(3, "0")}`),
      entityType: "Usage",
      projectName: "p",
      date: "2026-08-01",
      actor: `user:${String(index).padStart(3, "0")}`,
      ...counters(),
    }));
    const member = Array.from({ length: 205 }, (_, index) => ({
      ...keys.usageMember("member@example.com", "2026-08-01", `p-${String(index).padStart(3, "0")}`),
      entityType: "UsageMember",
      email: "member@example.com",
      projectName: `p-${String(index).padStart(3, "0")}`,
      date: "2026-08-01",
      ...counters(),
    }));
    store.seed([...days, ...actors, ...member]);
    const repository = new PostgresUsageRepository();

    await expect(repository.listByProject("p", "2026-01-01", "2026-05-30")).resolves.toHaveLength(
      150,
    );
    await expect(
      repository.listActorsByProject("p", "2026-08-01", "2026-08-01"),
    ).resolves.toHaveLength(205);
    await expect(
      repository.listMemberDays("member@example.com", "2026-08-01", "2026-08-01"),
    ).resolves.toHaveLength(205);
  });

  it("drains every project from a date-index page", async () => {
    store.seed(
      Array.from({ length: 205 }, (_, index) => {
        const projectName = `p-${String(index).padStart(3, "0")}`;
        return {
          ...keys.usage(projectName, "2026-08-01"),
          entityType: "Usage",
          GSI1PK: keys.usageDatePartition("2026-08-01"),
          GSI1SK: projectName,
          projectName,
          date: "2026-08-01",
          ...counters(),
        };
      }),
    );

    await expect(
      new PostgresUsageRepository().listByDateRange("2026-08-01", "2026-08-01"),
    ).resolves.toHaveLength(205);
  });
});
