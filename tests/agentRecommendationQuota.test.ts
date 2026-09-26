import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeStore } from "./fakeStore";

vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
const store = (await import("@/infrastructure/db/store")) as unknown as FakeStore;
const { keys } = await import("@/infrastructure/db/keys");
const {
  createAgentRecommendationQuota,
  MAX_AGENT_RECOMMENDATIONS_PER_MINUTE,
  MAX_AGENT_RECOMMENDATIONS_PER_DAY,
} = await import("@/infrastructure/db/repositories/agentRecommendationQuota");

beforeEach(() => store.rows.clear());

describe("Agent recommendation quota", () => {
  it("atomically limits a user's minute and resumes in the next minute", async () => {
    let instant = new Date("2026-09-24T12:00:30Z");
    const quota = createAgentRecommendationQuota(() => instant);
    for (let n = 0; n < MAX_AGENT_RECOMMENDATIONS_PER_MINUTE; n++) {
      expect(await quota.admit("USER@example.test")).toBeUndefined();
    }
    expect(await quota.admit("user@example.test")).toBe(30);
    instant = new Date("2026-09-24T12:01:00Z");
    expect(await quota.admit("user@example.test")).toBeUndefined();
    const row = await store.getItem(keys.agentRecommendationQuota("user@example.test", "2026-09-24"));
    expect(row).toMatchObject({ dayCount: MAX_AGENT_RECOMMENDATIONS_PER_MINUTE + 1, minuteCount: 1, expiresAt: 1790380800 });
  });

  it("limits the day while keeping different members separate", async () => {
    const instant = new Date("2026-09-24T12:00:00Z");
    const quota = createAgentRecommendationQuota(() => instant);
    await store.putItem({ ...keys.agentRecommendationQuota("person@example.test", "2026-09-24"),
      entityType: "AgentRecommendationQuota", date: "2026-09-24", minute: 0,
      dayCount: MAX_AGENT_RECOMMENDATIONS_PER_DAY, minuteCount: 0 });
    expect(await quota.admit("person@example.test")).toBe(43_200);
    expect(await quota.admit("other@example.test")).toBeUndefined();
  });
});
