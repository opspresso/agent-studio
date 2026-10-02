import { executionIdentity, withUserLimits } from "./runIdentity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireRunSlot,
  ConcurrencyLimitError,
  type ConcurrencyGuardDeps,
  type ConcurrencyLimits,
} from "@/application/run/concurrencyGuard";
import { openRun, openTaskRun } from "@/application/run/runBracket";
import { executeWorkspaceTask } from "@/application/execution/workspaceRun";
import type { Workspace } from "@/domain/workspace/types";
import type { AgentRepository } from "@/domain/agent/repository";
import { resetRunMetrics, runMetricsSnapshot } from "@/lib/runMetrics";
import { type RunActor } from "@/domain/execution/actor";
import { DEFAULT_MEMBER_TIERS, memberTierLimits } from "@/domain/member/tiers";
import { RUN_LEASE_SECONDS } from "@/shared/runDeadline";
import type { RunSlot, RunSlotRepository } from "@/domain/execution/runSlot";
import type { Agent, AgentConfiguration } from "@/domain/agent/types";
import type { UsageRepository } from "@/domain/usage/repository";

const ids = vi.hoisted(() => ({ sequence: 0 }));
vi.mock("node:crypto", async importOriginal => ({
  ...await importOriginal<typeof import("node:crypto")>(),
  randomUUID: () => `00000000-0000-4000-8000-${String(++ids.sequence).padStart(12, "0")}`,
}));
beforeEach(() => {
  ids.sequence = 0;
  vi.useFakeTimers();
  vi.setSystemTime("2026-07-29T12:00:00.000Z");
});
afterEach(() => vi.useRealTimers());

const LIMITS: ConcurrencyLimits = { perActor: 2 };

const agent: Agent = {
  name: "p",
  displayName: "P",
  description: "",
  ownerEmail: "owner@example.com",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

/** Minimal Agent configuration; the bracket reads only its model ids. */
const configuration: AgentConfiguration = {
  agentName: "p",

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
  listActorsByAgent: async () => [],
  listByAgent: async () => [],
  listByDateRange: async () => [],
};

/**
 * An in-memory stand-in with the same exactness guarantee as the PostgreSQL one:
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
    await acquireRunSlot(d, executionIdentity(user).user);
    await expect(acquireRunSlot(d, executionIdentity(user).user)).rejects.toBeInstanceOf(ConcurrencyLimitError);
    perActor = 2;
    await expect(acquireRunSlot(d, executionIdentity(user).user)).resolves.toBeDefined();
  });

  it("admits runs up to the limit and refuses the next", async () => {
    const d = deps();
    const first = await acquireRunSlot(d, executionIdentity(user).user);
    const second = await acquireRunSlot(d, executionIdentity(user).user);
    await expect(acquireRunSlot(d, executionIdentity(user).user)).rejects.toBeInstanceOf(ConcurrencyLimitError);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
  });

  it("frees the slot on release", async () => {
    const d = deps();
    const first = await acquireRunSlot(d, executionIdentity(user).user);
    await acquireRunSlot(d, executionIdentity(user).user);
    await first.release();
    await expect(acquireRunSlot(d, executionIdentity(user).user)).resolves.toBeDefined();
  });

  it("counts callers separately", async () => {
    const d = deps();
    await acquireRunSlot(d, executionIdentity(user).user);
    await acquireRunSlot(d, executionIdentity(user).user);
    // A different person is not affected by this one's limit.
    await expect(acquireRunSlot(d, executionIdentity({ kind: "user", id: "b@example.com" }).user)).resolves.toBeDefined();
  });

  it("shares a user's slots across interactive and personal token calls", async () => {
    const d = deps();
    await acquireRunSlot(d, executionIdentity(user).user);
    await acquireRunSlot(d, executionIdentity(user).user);
    await expect(
      acquireRunSlot(d, executionIdentity({ kind: "agent-token", id: "a@example.com" }).user),
    ).rejects.toBeInstanceOf(ConcurrencyLimitError);
  });

  it("reclaims a slot whose lease has expired", async () => {
    // The instance holding it died without releasing; nothing else can free it.
    // Start the repository clock at the same fixed instant the guard uses.
    let clock = Math.floor(Date.now() / 1000);
    const slots = memorySlots(() => clock);
    const d = { runSlots: slots.repo, limits: { perActor: 1 } };
    await acquireRunSlot(d, executionIdentity(user).user);
    await expect(acquireRunSlot(d, executionIdentity(user).user)).rejects.toBeInstanceOf(ConcurrencyLimitError);
    clock += RUN_LEASE_SECONDS + 1;
    await expect(acquireRunSlot(d, executionIdentity(user).user)).resolves.toBeDefined();
  });

  it("does not let an expired owner release a reused slot", async () => {
    let clock = Math.floor(Date.now() / 1000);
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock * 1000);
    const slots = memorySlots(() => clock);
    const d = { runSlots: slots.repo, limits: { perActor: 1 } };
    try {
      const expired = await acquireRunSlot(d, executionIdentity(user).user);
      clock += RUN_LEASE_SECONDS + 1;
      await acquireRunSlot(d, executionIdentity(user).user);
      await expired.release();

      await expect(acquireRunSlot(d, executionIdentity(user).user)).rejects.toBeInstanceOf(ConcurrencyLimitError);
    } finally {
      now.mockRestore();
    }
  });

  it("carries a 429 and a Retry-After shorter than the lease", async () => {
    const d = { runSlots: memorySlots().repo, limits: { perActor: 1 } };
    await acquireRunSlot(d, executionIdentity(user).user);
    const thrown = await acquireRunSlot(d, executionIdentity(user).user).then(
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
    await acquireRunSlot(instanceA, executionIdentity(user).user);
    await acquireRunSlot(instanceB, executionIdentity(user).user);
    await expect(acquireRunSlot(instanceA, executionIdentity(user).user)).rejects.toBeInstanceOf(ConcurrencyLimitError);
    await expect(acquireRunSlot(instanceB, executionIdentity(user).user)).rejects.toBeInstanceOf(ConcurrencyLimitError);
  });

  it("is disabled when no repository, no limits, or no actor is present", async () => {
    await expect(acquireRunSlot({}, executionIdentity(user).user)).resolves.toBeDefined();
    await expect(acquireRunSlot({ limits: LIMITS }, executionIdentity(user).user)).resolves.toBeDefined();
    await expect(acquireRunSlot(deps(), executionIdentity(undefined).user)).resolves.toBeDefined();
  });

  it("treats a zero limit as off rather than as a total block", async () => {
    const d = { runSlots: memorySlots().repo, limits: { perActor: 0 } };
    await expect(acquireRunSlot(d, executionIdentity(user).user)).resolves.toBeDefined();
  });

  it("fails closed when the slot store is unavailable", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // Unlike the cost guard: opening this one when the store is failing adds
    // load exactly when the store cannot take it.
    const d: ConcurrencyGuardDeps = {
      limits: LIMITS,
      runSlots: {
        renew: async () => false,
        acquire: async () => {
          throw new Error("slot store unavailable");
        },
        release: async () => {},
      },
    };
    await expect(acquireRunSlot(d, executionIdentity(user).user)).rejects.toBeInstanceOf(ConcurrencyLimitError);
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
    const slot = await acquireRunSlot(d, executionIdentity(user).user);
    await expect(slot.release()).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe("acquireRunSlot with a member tier", () => {
  it("does not read the deployment limit when the tier has its own", async () => {
    const limits = vi.fn(async () => { throw new Error("deployment limit unavailable"); });
    const d = deps({ limits });
    await expect(acquireRunSlot(d, executionIdentity(user).user, memberTierLimits("guest", DEFAULT_MEMBER_TIERS))).resolves.toBeDefined();
    expect(limits).not.toHaveBeenCalled();
  });
  const roomy = () => ({ runSlots: memorySlots().repo, limits: { perActor: 10 } });
  // Derived, not restated: the ceiling comes from the shared tier policy.
  const guestCeiling = memberTierLimits("guest", DEFAULT_MEMBER_TIERS).maxConcurrentRuns!;

  it("applies the tier's own ceiling under the deployment limit", async () => {
    const d = roomy();
    for (let i = 0; i < guestCeiling; i++) {
      await acquireRunSlot(d, executionIdentity(user).user, memberTierLimits("guest", DEFAULT_MEMBER_TIERS));
    }
    await expect(acquireRunSlot(d, executionIdentity(user).user, memberTierLimits("guest", DEFAULT_MEMBER_TIERS))).rejects.toBeInstanceOf(ConcurrencyLimitError);
  });

  it("lets a tier without its own ceiling inherit the deployment limit", async () => {
    const d = roomy();
    await acquireRunSlot(d, executionIdentity(user).user, memberTierLimits("member", DEFAULT_MEMBER_TIERS));
    await acquireRunSlot(d, executionIdentity(user).user, memberTierLimits("member", DEFAULT_MEMBER_TIERS));
    await expect(acquireRunSlot(d, executionIdentity(user).user, memberTierLimits("member", DEFAULT_MEMBER_TIERS))).resolves.toBeDefined();
  });
});

describe("openRun with a tier resolver", () => {
  it.each(["guest", "member"] as const)("shares the %s monthly cap between Chat and Workspace", async tier => {
    const cap = memberTierLimits(tier, DEFAULT_MEMBER_TIERS).monthlyCostCapUsd!;
    let spent = cap - 0.01;
    const d = {
      usage: { ...usage, listMemberDays: vi.fn(async () => [
        { userId: executionIdentity(user).user.userId, agentName: "chat-agent", date: "2026-07-29", calls: {}, inputTokens: {}, outputTokens: {}, costUsd: { m: spent / 2 } },
        { userId: executionIdentity(user).user.userId, agentName: "workspace-agent", date: "2026-07-29", calls: {}, inputTokens: {}, outputTokens: {}, costUsd: { m: spent / 2 } },
      ]) },
      runSlots: memorySlots().repo,
      resolveUserLimits: async () => memberTierLimits(tier, DEFAULT_MEMBER_TIERS),
    };
    const chat = await openRun(withUserLimits(d), agent, configuration, executionIdentity(user));
    await chat.close();
    const task = await openTaskRun(withUserLimits(d), agent, executionIdentity(user));
    await task.close();
    spent = cap;
    await expect(openRun(withUserLimits(d), agent, configuration, executionIdentity(user))).rejects.toMatchObject({ status: 429, limitUsd: cap });
    await expect(openTaskRun(withUserLimits(d), agent, executionIdentity(user))).rejects.toMatchObject({ status: 429, limitUsd: cap });
    const work = vi.fn(async () => false);
    const workspace = { agentName: agent.name, ownerEmail: user.id } as Workspace;
    const agents = { get: async () => agent } as unknown as AgentRepository;
    await expect(executeWorkspaceTask(withUserLimits(d), agents, workspace, work, executionIdentity(user))).rejects.toMatchObject({ status: 429 });
    expect(work).not.toHaveBeenCalled();
    expect(d.usage.listMemberDays).toHaveBeenCalledWith(executionIdentity(user).user.userId, "2026-07-01", "2026-07-29");
  });

  it("refuses both execution surfaces before acquiring a slot when spend cannot be read", async () => {
    const acquire = vi.fn();
    const d = {
      usage: { ...usage, listMemberDays: async () => { throw new Error("usage unavailable"); } },
      runSlots: { ...memorySlots().repo, acquire },
      resolveUserLimits: async () => memberTierLimits("guest", DEFAULT_MEMBER_TIERS),
    };
    await expect(openRun(withUserLimits(d), agent, configuration, executionIdentity(user))).rejects.toThrow("usage unavailable");
    await expect(openTaskRun(withUserLimits(d), agent, executionIdentity(user))).rejects.toThrow("usage unavailable");
    expect(acquire).not.toHaveBeenCalled();
  });

  it("refuses a guest's run past the tier ceiling", async () => {
    const d = {
      usage,
      runSlots: memorySlots().repo,
      limits: { perActor: 10 },
      resolveUserLimits: async () => memberTierLimits("guest", DEFAULT_MEMBER_TIERS),
    };
    const admitted = [];
    for (let i = 0; i < memberTierLimits("guest", DEFAULT_MEMBER_TIERS).maxConcurrentRuns!; i++) {
      admitted.push(await openRun(withUserLimits(d), agent, configuration, executionIdentity(user)));
    }
    await expect(openRun(withUserLimits(d), agent, configuration, executionIdentity(user))).rejects.toBeInstanceOf(ConcurrencyLimitError);
    for (const bracket of admitted) {
      await bracket.close();
    }
  });

  it("refuses Chat and Workspace execution when the tier lookup fails", async () => {
    const d = {
      usage,
      runSlots: memorySlots().repo,
      limits: { perActor: 10 },
      resolveUserLimits: async () => {
        throw new Error("member store down");
      },
    };
    await expect(openRun(withUserLimits(d), agent, configuration, executionIdentity(user))).rejects.toThrow("member store down");
    await expect(openTaskRun(withUserLimits(d), agent, executionIdentity(user))).rejects.toThrow("member store down");
  });
});

describe("openRun with a concurrency limit", () => {
  it.each(["agent-token", "slack", "webhook"] as const)("attributes a Workspace task to its %s caller rather than its managing member", async kind => {
    const actor = { kind, id: kind === "agent-token" ? agent.ownerEmail : kind === "webhook" ? agent.name + ":webhook" : "external-caller" };
    const workspace: Workspace = { id: "ws", chatId: "chat", agentName: agent.name, ownerEmail: agent.ownerEmail,
      title: "Task", runtime: "command", sessionId: "session", status: "active", revision: 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), dueAt: new Date().toISOString(), idleTtlSeconds: 60 };
    const repository = { get: vi.fn(async () => agent) } as unknown as AgentRepository;
    const d = { usage, runSlots: memorySlots().repo, limits: { perActor: 1 } };
    await executeWorkspaceTask(withUserLimits(d), repository, workspace, async () => {
      await expect(openTaskRun(withUserLimits(d), agent, executionIdentity(actor, workspace.ownerEmail))).rejects.toBeInstanceOf(ConcurrencyLimitError);
      await expect(openTaskRun(withUserLimits(d), agent, executionIdentity({ kind: "user", id: workspace.ownerEmail }))).rejects.toBeInstanceOf(ConcurrencyLimitError);
      return false;
    }, executionIdentity(actor, workspace.ownerEmail));
    const released = await openTaskRun(withUserLimits(d), agent, executionIdentity(actor, workspace.ownerEmail));
    await released.close();
  });

  it("shares slots with Workspace tasks that have no Agent model", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T00:00:00Z"));
    try {
      const d = { usage, runSlots: memorySlots().repo, limits: { perActor: 1 } };
      const task = await openTaskRun(withUserLimits(d), agent, executionIdentity(user));
      await expect(openRun(withUserLimits(d), agent, configuration, executionIdentity(user))).rejects.toBeInstanceOf(ConcurrencyLimitError);
      await task.close({ failed: true });
      const modelRun = await openRun(withUserLimits(d), agent, configuration, executionIdentity(user));
      await modelRun.close();
    } finally { vi.useRealTimers(); }
  });
  it("refuses past the limit without counting the run", async () => {
    resetRunMetrics();
    const d = { usage, ...deps() };
    const first = await openRun(withUserLimits(d), agent, configuration, executionIdentity(user));
    const second = await openRun(withUserLimits(d), agent, configuration, executionIdentity(user));
    await expect(openRun(withUserLimits(d), agent, configuration, executionIdentity(user))).rejects.toBeInstanceOf(ConcurrencyLimitError);
    expect(runMetricsSnapshot()).toMatchObject({ activeRuns: 2, runsStarted: 2 });
    await first.close();
    await second.close();
  });

  it("releases the slot when the run closes", async () => {
    const d = { usage, ...deps() };
    const first = await openRun(withUserLimits(d), agent, configuration, executionIdentity(user));
    const second = await openRun(withUserLimits(d), agent, configuration, executionIdentity(user));
    await first.close();
    const third = await openRun(withUserLimits(d), agent, configuration, executionIdentity(user));
    await second.close();
    await third.close();
  });

  it("releases a slot only once, however the generator unwinds", async () => {
    const slots = memorySlots();
    const d = { usage, runSlots: slots.repo, limits: LIMITS };
    const bracket = await openRun(withUserLimits(d), agent, configuration, executionIdentity(user));
    await bracket.close();
    // A second close must not free a slot a later run has since taken.
    const later = await openRun(withUserLimits(d), agent, configuration, executionIdentity(user));
    await bracket.close();
    expect(slots.held.get("studio-user:" + executionIdentity(user).user.userId)?.size).toBe(1);
    await later.close();
  });
});
