import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keys } from "@/infrastructure/db/keys";
import type { FakeStore } from "./fakeStore";

const tokens = vi.hoisted(() => ({ next: 0 }));
vi.mock("node:crypto", async (original) => ({
  ...await original<typeof import("node:crypto")>(),
  randomUUID: () => `00000000-0000-4000-8000-${String(++tokens.next).padStart(12, "0")}`,
}));

// In-memory store: the tests pin the claim-and-settle contract — what a row
// holds, which rows a claim may take — without a database. A storage fault is
// injected by failing the one store call the operation makes.
vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
const store = (await import("@/infrastructure/db/store")) as unknown as FakeStore;

const { slackEventRepository } = await import(
  "@/infrastructure/db/repositories/slackEventRepository"
);
const { telegramUpdateRepository } = await import("@/infrastructure/db/repositories/telegramUpdateRepository");
const { teamsActivityRepository } = await import("@/infrastructure/db/repositories/teamsActivityRepository");

const NOW = 1_700_000_000;
const LEASE_UNTIL = NOW + 660;

const row = (eventId: string) => store.getItem(keys.slackEvent(eventId));
const seed = (eventId: string, attributes: Record<string, unknown>) =>
  store.seed([{ ...keys.slackEvent(eventId), entityType: "slackEvent", ...attributes }]);

beforeEach(() => {
  store.rows.clear();
  vi.restoreAllMocks();
  tokens.next = 0;
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
});
afterEach(() => vi.useRealTimers());

describe("slackEventRepository.claim", () => {
  it("returns the stored token when the conditional put succeeds (first delivery)", async () => {
    const token = await slackEventRepository.claim("evt-1", NOW, LEASE_UNTIL);
    expect(token).toBeTypeOf("string");
    expect((await row("evt-1"))?.token).toBe(token);
  });

  it("returns null when the event is settled or another instance holds the lease", async () => {
    seed("evt-done", { state: "done", leaseExpiresAt: 0 });
    seed("evt-held", { state: "claimed", leaseExpiresAt: NOW + 100 });
    expect(await slackEventRepository.claim("evt-done", NOW, LEASE_UNTIL)).toBeNull();
    expect(await slackEventRepository.claim("evt-held", NOW, LEASE_UNTIL)).toBeNull();
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
   * and the condition would say only `claimed`, so a failed event was
   * refused as a duplicate forever (the integration check is what caught it).
   * Equally, a row that is `done`, or written before claims carried state, must
   * never be reclaimed, or a handled event would be replayed.
   */
  it("admits a claim whose lease expired or whose attempt failed, and never a settled one", async () => {
    seed("evt-expired", { state: "claimed", leaseExpiresAt: NOW - 1 });
    seed("evt-failed", { state: "failed", leaseExpiresAt: 0 });
    seed("evt-done", { state: "done", leaseExpiresAt: 0 });
    seed("evt-legacy", {});

    expect(await slackEventRepository.claim("evt-expired", NOW, LEASE_UNTIL)).toBeTypeOf("string");
    expect(await slackEventRepository.claim("evt-failed", NOW, LEASE_UNTIL)).toBeTypeOf("string");
    expect(await slackEventRepository.claim("evt-done", NOW, LEASE_UNTIL)).toBeNull();
    expect(await slackEventRepository.claim("evt-legacy", NOW, LEASE_UNTIL)).toBeNull();

    // A lease that runs out exactly now is not yet expired.
    seed("evt-edge", { state: "claimed", leaseExpiresAt: NOW });
    expect(await slackEventRepository.claim("evt-edge", NOW, LEASE_UNTIL)).toBeNull();
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
    const token = await slackEventRepository.claim("evt-1", NOW, LEASE_UNTIL);
    await slackEventRepository.settle("evt-1", token!, "done");
    expect(await row("evt-1")).toMatchObject({ state: "done", leaseExpiresAt: 0 });
    expect(typeof (await row("evt-1"))?.settledAt).toBe("string");
    // Unreclaimable from here on, however late the redelivery.
    expect(await slackEventRepository.claim("evt-1", NOW + 10_000, LEASE_UNTIL + 10_000)).toBeNull();
  });

  /** A failed attempt must stay retryable, not look like a success. */
  it("marks a failed attempt failed so a redelivery can reclaim it", async () => {
    const token = await slackEventRepository.claim("evt-1", NOW, LEASE_UNTIL);
    await slackEventRepository.settle("evt-1", token!, "failed");
    expect(await row("evt-1")).toMatchObject({ state: "failed", leaseExpiresAt: 0 });
    const nextToken = await slackEventRepository.claim("evt-1", NOW, LEASE_UNTIL);
    expect(nextToken).toBeTypeOf("string");
    expect(nextToken).not.toBe(token);
    const replacement = await row("evt-1");
    // Reclaiming in the same second still creates a distinct owner.
    await slackEventRepository.settle("evt-1", token!, "done");
    expect(await row("evt-1")).toEqual(replacement);
  });

  it.each(["done", "failed"] as const)("does not change an already %s attempt with the same token", async (outcome) => {
    const token = await slackEventRepository.claim("evt-1", NOW, LEASE_UNTIL);
    await slackEventRepository.settle("evt-1", token!, outcome);
    const settled = await row("evt-1");
    await slackEventRepository.settle("evt-1", token!, outcome === "done" ? "failed" : "done");
    expect(await row("evt-1")).toEqual(settled);
  });

  it("ignores a missing row (TTL purge) rather than failing the delivered response", async () => {
    await expect(slackEventRepository.settle("evt-1", "missing-token", "done")).resolves.toBeUndefined();
    // And does not materialise one: a settled row with no claim behind it
    // would be a handled event nothing handled.
    expect(await row("evt-1")).toBeNull();
  });

  it("rethrows non-conditional errors", async () => {
    vi.spyOn(store, "updateItem").mockRejectedValueOnce(new Error("network partition"));
    await expect(slackEventRepository.settle("evt-1", "token", "done")).rejects.toThrow(
      /network partition/,
    );
  });
});

describe.each([
  { name: "Slack event", claims: slackEventRepository, key: keys.slackEvent },
  { name: "Telegram update", claims: telegramUpdateRepository.forBot("p", 42).updates, key: (id: string) => keys.telegramUpdate("p", 42, id) },
  { name: "Telegram album", claims: telegramUpdateRepository.forBot("p", 42).albums, key: (id: string) => keys.telegramAlbum("p", 42, id) },
  { name: "Teams activity", claims: teamsActivityRepository.forBot("p", "app"), key: (id: string) => keys.teamsActivity("p", "app", id) },
])("$name claim ownership", ({ claims, key }) => {
  it.each(["done", "failed"] as const)("ignores an expired holder settling %s after another holder reclaims", async (outcome) => {
    const expiredToken = await claims.claim("evt-1", NOW, LEASE_UNTIL);
    const currentToken = await claims.claim("evt-1", LEASE_UNTIL + 1, LEASE_UNTIL + 600);
    expect(expiredToken).toBeTypeOf("string");
    expect(currentToken).toBeTypeOf("string");
    expect(currentToken).not.toBe(expiredToken);
    const replacement = await store.getItem(key("evt-1"));

    await claims.settle("evt-1", expiredToken!, outcome);

    expect(await store.getItem(key("evt-1"))).toEqual(replacement);
    expect(await claims.claim("evt-1", LEASE_UNTIL + 2, LEASE_UNTIL + 601)).toBeNull();
    await claims.settle("evt-1", currentToken!, "done");
    expect(await store.getItem(key("evt-1"))).toMatchObject({ state: "done", leaseExpiresAt: 0 });
  });

  it("does not settle another event using a valid token from this repository", async () => {
    const otherToken = await claims.claim("other", NOW, LEASE_UNTIL);
    const token = await claims.claim("evt-1", NOW, LEASE_UNTIL);
    const current = await store.getItem(key("evt-1"));
    await claims.settle("evt-1", otherToken!, "failed");
    expect(await store.getItem(key("evt-1"))).toEqual(current);
    await claims.settle("evt-1", token!, "failed");
    expect(await claims.claim("evt-1", NOW, LEASE_UNTIL)).toBeTypeOf("string");
  });
});
