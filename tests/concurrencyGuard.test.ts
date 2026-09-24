import { describe, expect, it, vi } from "vitest";
import {
  acquireRunSlot,
  ConcurrencyLimitError,
  type ConcurrencyGuardDeps,
  type ConcurrencyLimits,
} from "@/application/run/concurrencyGuard";
import { openRun, openTaskRun } from "@/application/run/runBracket";
import { resetRunMetrics, runMetricsSnapshot } from "@/lib/runMetrics";
import { type RunActor } from "@/domain/execution/actor";
import { TIER_LIMITS } from "@/domain/member/tiers";
import { RUN_LEASE_SECONDS } from "@/shared/runDeadline";
import type { RunSlot, RunSlotRepository } from "@/domain/execution/runSlot";
import type { Project, AgentConfiguration } from "@/domain/project/types";
import type { UsageRepository } from "@/domain/usage/repository";

const LIMITS: ConcurrencyLimits = { perActor: 2 };

const project: Project = {
  name: "p",
  displayName: "P",
  description: "",
  ownerEmail: "owner@example.com",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

/** Minimal Agent configuration; the bracket reads only its model ids. */
const configuration: AgentConfiguration = {
  projectName: "p",

  systemPrompt: "",

  model: "openai/gpt-5-mini",
  parameters: { piiFiltering: false },
  mcpList: [],
  skillList: [],
  subagentList: [],
};

const usage: UsageRepository = {
  record: async () => {},
  getDay: async () => null,
  listMemberDays: async () => [],
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
  const held = new Map<string, Map<number, { leaseUntil: number; token: string }>>();
  let nextToken = 0;
  const repo: RunSlotRepository = {
    async acquire(actor, limit, leaseUntilSeconds) {
      const slots = held.get(actor) ?? new Map<number, { leaseUntil: number; token: string }>();
      held.set(actor, slots);
      for (let index = 0; index < limit; index++) {
        const hold = slots.get(index);
        if (hold === undefined || hold.leaseUntil <= now()) {
          const token = String(++nextToken);
          slots.set(index, { leaseUntil: leaseUntilSeconds, token });
          return { index, token };
        }
      }
      return null;
    },
    async release(actor, slot: RunSlot) {
      const slots = held.get(actor);
      if (slots?.get(slot.index)?.token === slot.token) {
        slots.delete(slot.index);
      }
    },
    async renew(actor, slot, leaseUntilSeconds) {
      const current = held.get(actor)?.get(slot.index);
      if (current?.token !== slot.token || current.leaseUntil <= now()) return false;
      current.leaseUntil = leaseUntilSeconds;
      return true;
    },
  };
  return { repo, held };
}

function deps(overrides: Partial<ConcurrencyGuardDeps> = {}): ConcurrencyGuardDeps {
  return { runSlots: memorySlots().repo, limits: LIMITS, ...overrides };
}

const user: RunActor = { kind: "user", id: "a@example.com" };

describe("acquireRunSlot", () => {
  it("reads the current limit for each new run", async () => {
    const slots = memorySlots();
    let perActor = 1;
    const d = { runSlots: slots.repo, limits: async () => ({ perActor }) };
    await acquireRunSlot(d, user);
    await expect(acquireRunSlot(d, user)).rejects.toBeInstanceOf(ConcurrencyLimitError);
    perActor = 2;
    await expect(acquireRunSlot(d, user)).resolves.toBeDefined();
  });

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
    const d = { runSlots: slots.repo, limits: { perActor: 1 } };
    await acquireRunSlot(d, user);
    await expect(acquireRunSlot(d, user)).rejects.toBeInstanceOf(ConcurrencyLimitError);
    clock += RUN_LEASE_SECONDS + 1;
    await expect(acquireRunSlot(d, user)).resolves.toBeDefined();
  });

  it("does not let an expired owner release a reused slot", async () => {
    let clock = Math.floor(Date.now() / 1000);
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock * 1000);
    const slots = memorySlots(() => clock);
    const d = { runSlots: slots.repo, limits: { perActor: 1 } };
    try {
      const expired = await acquireRunSlot(d, user);
      clock += RUN_LEASE_SECONDS + 1;
      await acquireRunSlot(d, user);
      await expired.release();

      await expect(acquireRunSlot(d, user)).rejects.toBeInstanceOf(ConcurrencyLimitError);
    } finally {
      now.mockRestore();
    }
  });

  it("carries a 429 and a Retry-After shorter than the lease", async () => {
    const d = { runSlots: memorySlots().repo, limits: { perActor: 1 } };
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
    const d = { runSlots: memorySlots().repo, limits: { perActor: 0 } };
    await expect(acquireRunSlot(d, user)).resolves.toBeDefined();
  });

  it("fails closed when the slot store is unavailable", async () => {
    // Unlike the cost guard: opening this one when the store is failing adds
    // load exactly when the store cannot take it.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const d: ConcurrencyGuardDeps = {
      limits: LIMITS,
      runSlots: {
        renew: async () => false,
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
        renew: async () => false,
        acquire: async () => ({ index: 0, token: "run-1" }),
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

describe("acquireRunSlot with a member tier", () => {
  it("does not read the deployment limit when the tier has its own", async () => {
    const limits = vi.fn(async () => { throw new Error("deployment limit unavailable"); });
    const d = deps({ limits });
    await expect(acquireRunSlot(d, user, "guest")).resolves.toBeDefined();
    expect(limits).not.toHaveBeenCalled();
  });
  const roomy = () => ({ runSlots: memorySlots().repo, limits: { perActor: 10 } });
  // Derived, not restated: the number is TIER_LIMITS's to change.
  const guestCeiling = TIER_LIMITS.guest.maxConcurrentRuns!;

  it("applies the tier's own ceiling under the deployment limit", async () => {
    const d = roomy();
    for (let i = 0; i < guestCeiling; i++) {
      await acquireRunSlot(d, user, "guest");
    }
    await expect(acquireRunSlot(d, user, "guest")).rejects.toBeInstanceOf(ConcurrencyLimitError);
  });

  it("lets a tier without its own ceiling inherit the deployment limit", async () => {
    const d = roomy();
    await acquireRunSlot(d, user, "member");
    await acquireRunSlot(d, user, "member");
    await expect(acquireRunSlot(d, user, "member")).resolves.toBeDefined();
  });
});

describe("openRun with a tier resolver", () => {
  it("refuses a guest's run past the tier ceiling", async () => {
    const d = {
      usage,
      runSlots: memorySlots().repo,
      limits: { perActor: 10 },
      resolveActorTier: async () => "guest" as const,
    };
    const admitted = [];
    for (let i = 0; i < TIER_LIMITS.guest.maxConcurrentRuns!; i++) {
      admitted.push(await openRun(d, project, configuration, user));
    }
    await expect(openRun(d, project, configuration, user)).rejects.toBeInstanceOf(ConcurrencyLimitError);
    for (const bracket of admitted) {
      await bracket.close();
    }
  });

  it("falls back to the deployment limits when the resolver fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = {
      usage,
      runSlots: memorySlots().repo,
      limits: { perActor: 10 },
      resolveActorTier: async () => {
        throw new Error("member store down");
      },
    };
    const first = await openRun(d, project, configuration, user);
    const second = await openRun(d, project, configuration, user);
    const third = await openRun(d, project, configuration, user);
    await first.close();
    await second.close();
    await third.close();
    error.mockRestore();
  });
});

describe("openRun with a concurrency limit", () => {
  it("shares slots with Workspace tasks that have no Agent model", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T00:00:00Z"));
    try {
      const d = { usage, runSlots: memorySlots().repo, limits: { perActor: 1 } };
      const task = await openTaskRun(d, project, user);
      await expect(openRun(d, project, configuration, user)).rejects.toBeInstanceOf(ConcurrencyLimitError);
      await task.close({ failed: true });
      const modelRun = await openRun(d, project, configuration, user);
      await modelRun.close();
    } finally { vi.useRealTimers(); }
  });
  it("refuses past the limit without counting the run", async () => {
    resetRunMetrics();
    const d = { usage, ...deps() };
    const first = await openRun(d, project, configuration, user);
    const second = await openRun(d, project, configuration, user);
    await expect(openRun(d, project, configuration, user)).rejects.toBeInstanceOf(ConcurrencyLimitError);
    expect(runMetricsSnapshot()).toMatchObject({ activeRuns: 2, runsStarted: 2 });
    await first.close();
    await second.close();
  });

  it("releases the slot when the run closes", async () => {
    const d = { usage, ...deps() };
    const first = await openRun(d, project, configuration, user);
    await openRun(d, project, configuration, user);
    await first.close();
    await expect(openRun(d, project, configuration, user)).resolves.toBeDefined();
  });

  it("releases a slot only once, however the generator unwinds", async () => {
    const slots = memorySlots();
    const d = { usage, runSlots: slots.repo, limits: LIMITS };
    const bracket = await openRun(d, project, configuration, user);
    await bracket.close();
    // A second close must not free a slot a later run has since taken.
    const later = await openRun(d, project, configuration, user);
    await bracket.close();
    expect(slots.held.get("user:a@example.com")?.size).toBe(1);
    await later.close();
  });
});
