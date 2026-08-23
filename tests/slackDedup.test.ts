import { beforeEach, describe, expect, it, vi } from "vitest";
import { keys } from "@/infrastructure/db/keys";
import type { FakeStore } from "./fakeStore";

// In-memory store: the tests pin the claim-and-settle contract — what a row
// holds, which rows a claim may take — without a database. A storage fault is
// injected by failing the one store call the operation makes.
vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
const store = (await import("@/infrastructure/db/store")) as unknown as FakeStore;

const { slackEventRepository } = await import(
  "@/infrastructure/db/repositories/slackEventRepository"
);

const NOW = 1_700_000_000;
const LEASE_UNTIL = NOW + 660;

const row = (eventId: string) => store.getItem(keys.slackEvent(eventId));
const seed = (eventId: string, attributes: Record<string, unknown>) =>
  store.seed([{ ...keys.slackEvent(eventId), entityType: "slackEvent", ...attributes }]);

beforeEach(() => {
  store.rows.clear();
  vi.restoreAllMocks();
});

describe("slackEventRepository.claim", () => {
  it("returns true when the conditional put succeeds (first delivery)", async () => {
    expect(await slackEventRepository.claim("evt-1", NOW, LEASE_UNTIL)).toBe(true);
  });

  it("returns false when the event is settled or another instance holds the lease", async () => {
    seed("evt-done", { state: "done", leaseExpiresAt: 0 });
    seed("evt-held", { state: "claimed", leaseExpiresAt: NOW + 100 });
    expect(await slackEventRepository.claim("evt-done", NOW, LEASE_UNTIL)).toBe(false);
    expect(await slackEventRepository.claim("evt-held", NOW, LEASE_UNTIL)).toBe(false);
    // And the refused claim left the rows as they were.
    expect(await row("evt-done")).toMatchObject({ state: "done" });
    expect(await row("evt-held")).toMatchObject({ state: "claimed", leaseExpiresAt: NOW + 100 });
  });

  it("rethrows non-conditional errors instead of treating them as duplicates", async () => {
    vi.spyOn(store, "putItem").mockRejectedValueOnce(new Error("network partition"));
    await expect(slackEventRepository.claim("evt-1", NOW, LEASE_UNTIL)).rejects.toThrow(
      /network partition/,
    );
  });

  /**
   * The point of the lease: an instance that died mid-processing leaves a
   * `claimed` row behind, and a redelivery must be able to take it over rather
   * than be refused as a duplicate of work that never happened. A `failed`
   * attempt is reclaimable outright — that is what settling as failed is *for*,
   * and the condition used to say only `claimed`, so a failed event was
   * refused as a duplicate forever (the integration check is what caught it).
   * Equally, a row that is `done`, or written before claims carried state, must
   * never be reclaimed, or a handled event would be replayed.
   */
  it("admits a claim whose lease expired or whose attempt failed, and never a settled one", async () => {
    seed("evt-expired", { state: "claimed", leaseExpiresAt: NOW - 1 });
    seed("evt-failed", { state: "failed", leaseExpiresAt: 0 });
    seed("evt-done", { state: "done", leaseExpiresAt: 0 });
    seed("evt-legacy", {});

    expect(await slackEventRepository.claim("evt-expired", NOW, LEASE_UNTIL)).toBe(true);
    expect(await slackEventRepository.claim("evt-failed", NOW, LEASE_UNTIL)).toBe(true);
    expect(await slackEventRepository.claim("evt-done", NOW, LEASE_UNTIL)).toBe(false);
    expect(await slackEventRepository.claim("evt-legacy", NOW, LEASE_UNTIL)).toBe(false);

    // A lease that runs out exactly now is not yet expired.
    seed("evt-edge", { state: "claimed", leaseExpiresAt: NOW });
    expect(await slackEventRepository.claim("evt-edge", NOW, LEASE_UNTIL)).toBe(false);
  });

  it("writes the lease deadline and a claimed state on the row", async () => {
    await slackEventRepository.claim("evt-1", NOW, LEASE_UNTIL);
    expect(await row("evt-1")).toMatchObject({
      entityType: "slackEvent",
      state: "claimed",
      leaseExpiresAt: LEASE_UNTIL,
      expiresAt: NOW + 60 * 60 * 24,
    });
    expect(typeof (await row("evt-1"))?.claimedAt).toBe("string");
  });
});

describe("slackEventRepository.settle", () => {
  it("retires a completed claim and leaves no live lease", async () => {
    await slackEventRepository.claim("evt-1", NOW, LEASE_UNTIL);
    await slackEventRepository.settle("evt-1", "done");
    expect(await row("evt-1")).toMatchObject({ state: "done", leaseExpiresAt: 0 });
    expect(typeof (await row("evt-1"))?.settledAt).toBe("string");
    // Unreclaimable from here on, however late the redelivery.
    expect(await slackEventRepository.claim("evt-1", NOW + 10_000, LEASE_UNTIL + 10_000)).toBe(false);
  });

  /** A failed attempt must stay retryable, not look like a success. */
  it("marks a failed attempt failed so a redelivery can reclaim it", async () => {
    await slackEventRepository.claim("evt-1", NOW, LEASE_UNTIL);
    await slackEventRepository.settle("evt-1", "failed");
    expect(await row("evt-1")).toMatchObject({ state: "failed", leaseExpiresAt: 0 });
    expect(await slackEventRepository.claim("evt-1", NOW, LEASE_UNTIL)).toBe(true);
  });

  it("ignores a missing row (TTL purge) rather than failing the delivered response", async () => {
    await expect(slackEventRepository.settle("evt-1", "done")).resolves.toBeUndefined();
    // And does not materialise one: a settled row with no claim behind it
    // would be a handled event nothing handled.
    expect(await row("evt-1")).toBeNull();
  });

  it("rethrows non-conditional errors", async () => {
    vi.spyOn(store, "updateItem").mockRejectedValueOnce(new Error("network partition"));
    await expect(slackEventRepository.settle("evt-1", "done")).rejects.toThrow(
      /network partition/,
    );
  });
});
