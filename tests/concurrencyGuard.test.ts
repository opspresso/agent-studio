import { describe, expect, it, vi } from "vitest";
import {
  acquireRunSlot,
  ConcurrencyLimitError,
  limitFor,
  type ConcurrencyGuardDeps,
  type ConcurrencyLimits,
} from "@/application/execution/concurrencyGuard";
import { openRun } from "@/application/execution/runBracket";
import { resetRunMetrics, runMetricsSnapshot } from "@/lib/runMetrics";
import { A2A_ACTOR_ID, type RunActor } from "@/domain/execution/actor";
import { RUN_LEASE_SECONDS } from "@/shared/runDeadline";
import type { RunSlot, RunSlotRepository } from "@/domain/execution/runSlot";
import type { Project, Version } from "@/domain/project/types";
import type { UsageRepository } from "@/domain/usage/repository";

const LIMITS: ConcurrencyLimits = { perActor: 2, a2a: 5 };

const project: Project = {
  name: "p",
  displayName: "P",
  description: "",
  projectType: "agent",
  ownerEmail: "owner@example.com",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

/** Minimal version; the bracket reads only its model ids. */
const version: Version = {
  projectName: "p",
  versionName: "v1",
  systemPrompt: "",
  userPromptTemplate: "",
  model: "openai/gpt-5-mini",
  parameters: { piiFiltering: false },
  mcpList: [],
  skillList: [],
  subagentList: [],
  createdAt: "2026-01-01T00:00:00Z",
};

const usage: UsageRepository = {
  record: async () => {},
  getDay: async () => null,
  claimAlert: async () => false,
  claimMonthAlert: async () => false,
  listActorsByProject: async () => [],
  listByProject: async () => [],
  listByDateRange: async () => [],
};

/**
 * An in-memory stand-in with the same exactness guarantee as the DynamoDB one:
 * each index is held by at most one run, and a lease that has passed is free.
 */
function memorySlots(now = () => Math.floor(Date.now() / 1000)) {
  const held = new Map<string, Map<number, number>>();
  const repo: RunSlotRepository = {
    async acquire(actor, limit, leaseUntilSeconds) {
      const slots = held.get(actor) ?? new Map<number, number>();
      held.set(actor, slots);
      for (let index = 0; index < limit; index++) {
        const lease = slots.get(index);
        if (lease === undefined || lease <= now()) {
          slots.set(index, leaseUntilSeconds);
          return { index };
        }
      }
      return null;
    },
    async release(actor, slot: RunSlot) {
      held.get(actor)?.delete(slot.index);
    },
  };
  return { repo, held };
}

function deps(overrides: Partial<ConcurrencyGuardDeps> = {}): ConcurrencyGuardDeps {
  return { runSlots: memorySlots().repo, limits: LIMITS, ...overrides };
}

const user: RunActor = { kind: "user", id: "a@example.com" };

describe("limitFor", () => {
  it("uses the per-actor limit for identified callers", () => {
    expect(limitFor(LIMITS, user)).toBe(2);
    expect(limitFor(LIMITS, { kind: "slack", id: "U1" })).toBe(2);
    expect(limitFor(LIMITS, { kind: "project-token", id: "a@example.com" })).toBe(2);
  });

  it("gives A2A its own, because one identity stands for every caller", () => {
    expect(limitFor(LIMITS, { kind: "a2a", id: A2A_ACTOR_ID })).toBe(5);
  });
});

describe("acquireRunSlot", () => {
  it("admits runs up to the limit and refuses the next", async () => {
    const d = deps();
    const first = await acquireRunSlot(d, user);
    const second = await acquireRunSlot(d, user);
    await expect(acquireRunSlot(d, user)).rejects.toBeInstanceOf(ConcurrencyLimitError);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
  });

  it("frees the slot on release", async () => {
    const d = deps();
    const first = await acquireRunSlot(d, user);
    await acquireRunSlot(d, user);
    await first.release();
    await expect(acquireRunSlot(d, user)).resolves.toBeDefined();
  });

  it("counts callers separately", async () => {
    const d = deps();
    await acquireRunSlot(d, user);
    await acquireRunSlot(d, user);
    // A different person is not affected by this one's limit.
    await expect(acquireRunSlot(d, { kind: "user", id: "b@example.com" })).resolves.toBeDefined();
  });

  it("keeps a token's slots apart from its owner's own runs", async () => {
    const d = deps();
    await acquireRunSlot(d, user);
    await acquireRunSlot(d, user);
    await expect(
      acquireRunSlot(d, { kind: "project-token", id: "a@example.com" }),
    ).resolves.toBeDefined();
  });

  it("reclaims a slot whose lease has expired", async () => {
    // The instance holding it died without releasing; nothing else can free it.
    // The clock starts at the real epoch because the lease the guard writes is
    // derived from `Date.now()` — a fake scale would never reach it.
    let clock = Math.floor(Date.now() / 1000);
    const slots = memorySlots(() => clock);
    const d = { runSlots: slots.repo, limits: { perActor: 1, a2a: 1 } };
    await acquireRunSlot(d, user);
    await expect(acquireRunSlot(d, user)).rejects.toBeInstanceOf(ConcurrencyLimitError);
    clock += RUN_LEASE_SECONDS + 1;
    await expect(acquireRunSlot(d, user)).resolves.toBeDefined();
  });

  it("carries a 429 and a Retry-After shorter than the lease", async () => {
    const d = { runSlots: memorySlots().repo, limits: { perActor: 1, a2a: 1 } };
    await acquireRunSlot(d, user);
    const thrown = await acquireRunSlot(d, user).then(
      () => null,
      (error: unknown) => error as ConcurrencyLimitError,
    );
    expect(thrown?.status).toBe(429);
    // A slot usually frees when a run finishes, long before its lease expires,
    // so the wait must not be the lease length.
    expect(thrown?.retryAfterSeconds).toBeGreaterThan(0);
    expect(thrown?.retryAfterSeconds).toBeLessThan(RUN_LEASE_SECONDS);
  });

  it("does not multiply the limit by the number of instances", async () => {
    // The reason the state is not in `runMetrics`: a per-process count would
    // let two instances admit `limit` runs each.
    const shared = memorySlots().repo;
    const instanceA: ConcurrencyGuardDeps = { runSlots: shared, limits: LIMITS };
    const instanceB: ConcurrencyGuardDeps = { runSlots: shared, limits: LIMITS };
    await acquireRunSlot(instanceA, user);
    await acquireRunSlot(instanceB, user);
    await expect(acquireRunSlot(instanceA, user)).rejects.toBeInstanceOf(ConcurrencyLimitError);
    await expect(acquireRunSlot(instanceB, user)).rejects.toBeInstanceOf(ConcurrencyLimitError);
  });

  it("is disabled when no repository, no limits, or no actor is present", async () => {
    await expect(acquireRunSlot({}, user)).resolves.toBeDefined();
    await expect(acquireRunSlot({ limits: LIMITS }, user)).resolves.toBeDefined();
    await expect(acquireRunSlot(deps(), undefined)).resolves.toBeDefined();
  });

  it("treats a zero limit as off rather than as a total block", async () => {
    const d = { runSlots: memorySlots().repo, limits: { perActor: 0, a2a: 0 } };
    await expect(acquireRunSlot(d, user)).resolves.toBeDefined();
  });

  it("fails closed when the slot store is unavailable", async () => {
    // Unlike the cost guard: opening this one when the store is failing adds
    // load exactly when the store cannot take it.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const d: ConcurrencyGuardDeps = {
      limits: LIMITS,
      runSlots: {
        acquire: async () => {
          throw new Error("dynamo down");
        },
        release: async () => {},
      },
    };
    await expect(acquireRunSlot(d, user)).rejects.toBeInstanceOf(ConcurrencyLimitError);
    error.mockRestore();
  });

  it("never lets a failed release wedge the limit", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d: ConcurrencyGuardDeps = {
      limits: LIMITS,
      runSlots: {
        acquire: async () => ({ index: 0 }),
        release: async () => {
          throw new Error("delete failed");
        },
      },
    };
    const slot = await acquireRunSlot(d, user);
    await expect(slot.release()).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe("openRun with a concurrency limit", () => {
  it("refuses past the limit without counting the run", async () => {
    resetRunMetrics();
    const d = { usage, ...deps() };
    const first = await openRun(d, project, version, user);
    const second = await openRun(d, project, version, user);
    await expect(openRun(d, project, version, user)).rejects.toBeInstanceOf(ConcurrencyLimitError);
    expect(runMetricsSnapshot()).toMatchObject({ activeRuns: 2, runsStarted: 2 });
    await first.close();
    await second.close();
  });

  it("releases the slot when the run closes", async () => {
    const d = { usage, ...deps() };
    const first = await openRun(d, project, version, user);
    await openRun(d, project, version, user);
    await first.close();
    await expect(openRun(d, project, version, user)).resolves.toBeDefined();
  });

  it("releases a slot only once, however the generator unwinds", async () => {
    const slots = memorySlots();
    const d = { usage, runSlots: slots.repo, limits: LIMITS };
    const bracket = await openRun(d, project, version, user);
    await bracket.close();
    // A second close must not free a slot a later run has since taken.
    const later = await openRun(d, project, version, user);
    await bracket.close();
    expect(slots.held.get("user:a@example.com")?.size).toBe(1);
    await later.close();
  });
});
