import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageDelta } from "@/domain/usage/types";
import { keys } from "@/infrastructure/db/keys";
import type { FakeStore } from "./fakeStore";
import { assertWithinMemberCostLimit, MemberCostLimitExceededError } from "@/application/usage/memberCostGuard";

vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
const store = (await import("@/infrastructure/db/store")) as unknown as FakeStore;

const { PostgresUsageRepository } = await import("@/infrastructure/db/repositories/usageRepository");

const NOW_MS = Date.parse("2026-08-13T12:00:00Z");

const delta = (actor = "user:a@x.com", model = "m", userId = "account-a"): UsageDelta => ({
  agentName: "p",
  date: "2026-08-13",
  model,
  calls: 1,
  inputTokens: 10,
  outputTokens: 5,
  costUsd: 0.5,
  actor, userId,
});

const memberRows = () =>
  store.all().filter((row) => String(row.PK).startsWith("USAGEMEMBERID#"));

beforeEach(() => {
  store.rows.clear();
  // Every usage write checks the agent is live first, so the partition it
  // lands in is not one a cascade delete is sweeping.
  store.seed([{ ...keys.agent("p"), entityType: "AGENT", name: "p" }]);
  vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
});

describe("the member day row", () => {
  it("is written beside the agent and actor rows, keyed by user ID, UTC day and agent, for a user actor", async () => {
    await new PostgresUsageRepository().record(delta("user:a@x.com"));

    expect(memberRows()).toHaveLength(1);
    expect(memberRows()[0]).toMatchObject({
      PK: "USAGEMEMBERID#account-a",
      SK: "DATE#2026-08-13#p",
      entityType: "UsageMember",
      userId: "account-a",
      agentName: "p",
      date: "2026-08-13",
      calls: { m: 1 },
      inputTokens: { m: 10 },
      outputTokens: { m: 5 },
      cachedTokens: { m: 0 },
      costUsd: { m: 0.5 },
    });
    expect(typeof memberRows()[0]?.expiresAt).toBe("number");
    // Additive, not a replacement of the agent's own accounting: the
    // agent total and the actor row are written too.
    expect(store.all().map((row) => `${row.PK} ${row.SK}`)).toEqual(
      expect.arrayContaining([
        "USAGE#p DATE#2026-08-13",
        "USAGE#p ACTOR#2026-08-13#user%3Aa%40x.com#USER#account-a",
        "USAGEMEMBERID#account-a DATE#2026-08-13#p",
      ]),
    );
  });

  it("adds a second record for the same day into the same per-model maps", async () => {
    const repo = new PostgresUsageRepository();
    await repo.record(delta("user:a@x.com"));
    await repo.record(delta("user:a@x.com"));
    await repo.record(delta("user:a@x.com", "other"));

    expect(memberRows()).toHaveLength(1);
    expect(memberRows()[0]).toMatchObject({
      calls: { m: 2, other: 1 },
      costUsd: { m: 1, other: 0.5 },
    });
  });

  it("combines personal token, webhook, schedule and messenger spend under one account", async () => {
    const repo = new PostgresUsageRepository();
    for (const actor of ["user:a@x.com", "agent-token:a@x.com", "slack:U1", "telegram:1", "teams:T1", "webhook:p:webhook", "schedule:p:daily"]) {
      await repo.record(delta(actor));
    }
    expect(memberRows()).toHaveLength(1);
    expect(memberRows()[0]).toMatchObject({ userId: "account-a", calls: { m: 7 }, costUsd: { m: 3.5 } });
    expect(await repo.listActorsByAgent("p", "2026-08-13", "2026-08-13", 20)).toHaveLength(7);
    await expect(assertWithinMemberCostLimit({ usage: repo }, { userId: "account-a", email: "a@x.com" },
      { monthlyCostCapUsd: 3 }, new Date(NOW_MS))).rejects.toBeInstanceOf(MemberCostLimitExceededError);
    await expect(assertWithinMemberCostLimit({ usage: repo }, { userId: "replacement-account", email: "a@x.com" },
      { monthlyCostCapUsd: 3 }, new Date(NOW_MS))).resolves.toBeUndefined();
  });

  it("separates two Studio accounts even when their source actor and email are identical", async () => {
    const repo = new PostgresUsageRepository();
    await repo.record(delta("webhook:p:webhook", "m", "account-a"));
    await repo.record(delta("webhook:p:webhook", "m", "account-b"));
    expect(memberRows()).toHaveLength(2);
    const actors = await repo.listActorsByAgent("p", "2026-08-13", "2026-08-13", 20);
    expect(actors.map(row => row.userId).sort()).toEqual(["account-a", "account-b"]);
  });

  it("refuses unattributed usage before writing any projection", async () => {
    const input = delta();
    Reflect.deleteProperty(input, "userId");
    await expect(new PostgresUsageRepository().record(input)).rejects.toThrow("authenticated Studio caller");
    expect(store.all()).toHaveLength(1);
  });

});

describe("listMemberDays", () => {
  it("reads the member's own partition across the day range, every agent on the last day included", async () => {
    const nowSeconds = Math.floor(NOW_MS / 1000);
    const row = (date: string, agentName: string, extra: Record<string, unknown> = {}) => ({
      ...keys.usageMember("account-a", date, agentName),
      entityType: "UsageMember",
      userId: "account-a",
      agentName,
      date,
      costUsd: { m: 3 },
      calls: { m: 2 },
      expiresAt: nowSeconds + 86_400,
      ...extra,
    });
    store.seed([
      row("2026-07-31", "p"),
      row("2026-08-01", "p"),
      // Past the first agent name on the last day — the bound is the day,
      // not any agent guessed for it.
      row("2026-08-13", "p"),
      row("2026-08-13", "zzz"),
      row("2026-08-14", "p"),
      // Swept late: an expired row must not count against the window.
      row("2026-08-10", "p", { expiresAt: nowSeconds - 1 }),
      { ...keys.usageMember("account-b", "2026-08-13", "p"), userId: "account-b", agentName: "p", date: "2026-08-13" },
    ]);

    const shape = (date: string, agentName: string) => ({
      userId: "account-a",
      agentName,
      date,
      calls: { m: 2 },
      inputTokens: {},
      outputTokens: {},
      cachedTokens: {},
      costUsd: { m: 3 },
    });
    await expect(
      new PostgresUsageRepository().listMemberDays("account-a", "2026-08-01", "2026-08-13"),
    ).resolves.toEqual([
      shape("2026-08-01", "p"),
      shape("2026-08-13", "p"),
      shape("2026-08-13", "zzz"),
    ]);
  });

  it("answers an empty list when nothing was spent", async () => {
    await expect(
      new PostgresUsageRepository().listMemberDays("account-a", "2026-08-01", "2026-08-13"),
    ).resolves.toEqual([]);
  });
});
