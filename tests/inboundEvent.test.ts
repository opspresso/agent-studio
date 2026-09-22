import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keys } from "@/infrastructure/db/keys";
import { RUN_LEASE_SECONDS } from "@/shared/runDeadline";
import type { FakeStore } from "./fakeStore";

const background = vi.hoisted(() => ({ jobs: [] as Array<() => Promise<void>>, nextToken: 0 }));
vi.mock("next/server", () => ({ after: (job: () => Promise<void>) => background.jobs.push(job) }));
vi.mock("node:crypto", async (original) => ({
  ...await original<typeof import("node:crypto")>(),
  randomUUID: () => `00000000-0000-4000-8000-${String(++background.nextToken).padStart(12, "0")}`,
}));
vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
const store = (await import("@/infrastructure/db/store")) as unknown as FakeStore;
const { slackEventRepository } = await import("@/infrastructure/db/repositories/slackEventRepository");
const { admitInboundEvent } = await import("@/app/api/_lib/inboundEvent");

const NOW = 1_700_000_000_000;
const readClaim = () => store.getItem(keys.slackEvent("event"));
const admit = (work: () => Promise<void>) => admitInboundEvent({
  claims: slackEventRepository,
  eventId: "event",
  scope: "slack",
  logLabel: "test",
  work,
});

beforeEach(() => {
  store.rows.clear();
  background.jobs.length = 0;
  background.nextToken = 0;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("inbound event background ownership", () => {
  it.each(["done", "failed"] as const)("keeps the replacement claim when expired background work finishes %s", async (outcome) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const oldWork = Promise.withResolvers<void>();
    expect(await admit(() => oldWork.promise)).toBe("accepted");
    const oldJob = background.jobs[0]!();

    vi.setSystemTime(NOW + (RUN_LEASE_SECONDS + 1) * 1000);
    const currentWork = vi.fn(async () => {});
    expect(await admit(currentWork)).toBe("accepted");
    const replacement = await readClaim();

    if (outcome === "failed") {
      oldWork.reject(new Error("old attempt failed"));
    } else {
      oldWork.resolve();
    }
    await oldJob;

    expect(await readClaim()).toEqual(replacement);
    expect(await admit(async () => {})).toBe("duplicate");
    expect(background.jobs).toHaveLength(2);
    await background.jobs[1]!();
    expect(currentWork).toHaveBeenCalledOnce();
    expect(await readClaim()).toMatchObject({ token: replacement?.token, state: "done" });
  });

  it("runs an event without an id without claiming or settling a row", async () => {
    const claims = { claim: vi.fn(async () => "unused"), settle: vi.fn(async () => {}) };
    const work = vi.fn(async () => {});
    expect(await admitInboundEvent({ claims, eventId: undefined, scope: "slack", logLabel: "test", work })).toBe("accepted");
    await background.jobs[0]!();
    expect(work).toHaveBeenCalledOnce();
    expect(claims.claim).not.toHaveBeenCalled();
    expect(claims.settle).not.toHaveBeenCalled();
  });
});
