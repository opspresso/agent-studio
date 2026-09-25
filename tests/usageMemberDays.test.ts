import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageDelta } from "@/domain/usage/types";
import { keys } from "@/infrastructure/db/keys";
import type { FakeStore } from "./fakeStore";

vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
const store = (await import("@/infrastructure/db/store")) as unknown as FakeStore;

const { PostgresUsageRepository } = await import("@/infrastructure/db/repositories/usageRepository");

const NOW_MS = Date.parse("2026-08-13T12:00:00Z");

const delta = (actor?: string, model = "m"): UsageDelta => ({
  agentName: "p",
  date: "2026-08-13",
  model,
  calls: 1,
  inputTokens: 10,
  outputTokens: 5,
  costUsd: 0.5,
  ...(actor ? { actor } : {}),
});

const memberRows = () =>
  store.all().filter((row) => String(row.PK).startsWith("USAGEMEMBER#"));

beforeEach(() => {
  store.rows.clear();
  // Every usage write checks the agent is live first, so the partition it
  // lands in is not one a cascade delete is sweeping.
  store.seed([{ ...keys.agent("p"), entityType: "AGENT", name: "p" }]);
  vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
});

describe("the member day row", () => {
  it("is written beside the agent and actor rows, keyed by email, UTC day and agent, for a user actor", async () => {
    await new PostgresUsageRepository().record(delta("user:a@x.com"));

    expect(memberRows()).toHaveLength(1);
    expect(memberRows()[0]).toMatchObject({
      PK: "USAGEMEMBER#a@x.com",
      SK: "DATE#2026-08-13#p",
      entityType: "UsageMember",
      email: "a@x.com",
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
        "USAGE#p ACTOR#2026-08-13#user:a@x.com",
        "USAGEMEMBER#a@x.com DATE#2026-08-13#p",
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

  it("is not written for agent tokens, machine actors, or unattributed spend", async () => {
    // A token spends against its agent's limits, never its owner's budget.
    await new PostgresUsageRepository().record(delta("agent-token:a@x.com"));
    await new PostgresUsageRepository().record(delta("slack:U1"));
    await new PostgresUsageRepository().record(delta());
    expect(memberRows()).toHaveLength(0);
  });
});

describe("listMemberDays", () => {
  it("reads the member's own partition across the day range, every agent on the last day included", async () => {
    const nowSeconds = Math.floor(NOW_MS / 1000);
    const row = (date: string, agentName: string, extra: Record<string, unknown> = {}) => ({
      ...keys.usageMember("a@x.com", date, agentName),
      entityType: "UsageMember",
      email: "a@x.com",
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
      { ...keys.usageMember("b@x.com", "2026-08-13", "p"), email: "b@x.com", agentName: "p", date: "2026-08-13" },
    ]);

    const shape = (date: string, agentName: string) => ({
      email: "a@x.com",
      agentName,
      date,
      calls: { m: 2 },
      inputTokens: {},
      outputTokens: {},
      cachedTokens: {},
      costUsd: { m: 3 },
    });
    await expect(
      new PostgresUsageRepository().listMemberDays("a@x.com", "2026-08-01", "2026-08-13"),
    ).resolves.toEqual([
      shape("2026-08-01", "p"),
      shape("2026-08-13", "p"),
      shape("2026-08-13", "zzz"),
    ]);
  });

  it("answers an empty list when nothing was spent", async () => {
    await expect(
      new PostgresUsageRepository().listMemberDays("a@x.com", "2026-08-01", "2026-08-13"),
    ).resolves.toEqual([]);
  });
});
