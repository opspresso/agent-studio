import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keys } from "@/infrastructure/db/keys";
import type { FakeStore } from "./fakeStore";

vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
const store = (await import("@/infrastructure/db/store")) as unknown as FakeStore;
const { slackThreadRepository } = await import("@/infrastructure/db/repositories/slackThreadRepository");

const target = ["project", "channel", "123.456"] as const;
const row = () => store.getItem(keys.slackThread(...target));

beforeEach(() => {
  store.rows.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("slackThreadRepository", () => {
  it("keeps an explicit mute when a mentioned reply refreshes engagement", async () => {
    await slackThreadRepository.markEngaged(...target);
    await slackThreadRepository.setMuted(...target, true);
    await slackThreadRepository.markEngaged(...target);

    expect(await row()).toMatchObject({ muted: true });
    expect(await slackThreadRepository.isEngaged(...target)).toBe(false);

    await slackThreadRepository.setMuted(...target, false);
    expect(await slackThreadRepository.isEngaged(...target)).toBe(true);
  });
});
