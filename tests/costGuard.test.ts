import { describe, expect, it, vi } from "vitest";
import {
  assertWithinCostLimit,
  CostLimitExceededError,
  secondsUntilUtcMidnight,
  settleCostLimit,
  type CostGuardDeps,
} from "@/application/usage/costGuard";
import { openRun } from "@/application/run/runBracket";
import { prepareSubagent } from "@/application/execution/agentBindings";
import {
  executeAgent,
  executeProject,
  executeProjectStream,
  type ExecutionDeps,
} from "@/application/execution/runProject";
import { resetRunMetrics, runMetricsSnapshot } from "@/lib/runMetrics";
import type { CostLimits, Project, Version } from "@/domain/project/types";
import type { CostAlertKind, UsageRepository } from "@/domain/usage/repository";
import type { UsageRow } from "@/domain/usage/types";
import { fakeSkillRepository } from "./fakeSkills";

// A getter, not a module-load constant: the guard computes its own current
// date at call time, and a suite that loads this module before UTC midnight
// and runs the test after it would compare two different days.
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function project(costLimits?: CostLimits, slackEnabled = false): Project {
  return {
    name: "proj",
    displayName: "Proj",
    description: "",
    projectType: "agent",
    ownerEmail: "owner@example.com",
    ...(costLimits ? { costLimits } : {}),
    ...(slackEnabled
      ? { slack: { botToken: "enc:token", signingSecret: "enc:secret", enabled: true } }
      : {}),
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function row(costUsd: Record<string, number>): UsageRow {
  return {
    projectName: "proj",
    date: today(),
    calls: {},
    inputTokens: {},
    outputTokens: {},
    costUsd,
  };
}

interface Fixture {
  deps: CostGuardDeps;
  claims: Array<{ kind: CostAlertKind; date: string }>;
  posted: Array<{ token: string; channel: string; text: string }>;
}

function fixture(
  opts: {
    day?: UsageRow | null;
    dayError?: Error;
    /** The month's daily rows, returned by `listByProject`. */
    month?: UsageRow[];
    /** Fails only the month query, so the windows can fail independently. */
    monthError?: Error;
    claimable?: boolean;
    withSlack?: boolean;
  } = {},
): Fixture {
  const claims: Fixture["claims"] = [];
  const posted: Fixture["posted"] = [];
  const usage: UsageRepository = {
    record: async () => {},
    async getDay() {
      if (opts.dayError) {
        throw opts.dayError;
      }
      return opts.day ?? null;
    },
    listMemberDays: async () => [],
    async claimAlert(_projectName, date, kind) {
      claims.push({ kind, date });
      return opts.claimable ?? true;
    },
    async claimMonthAlert(_projectName, month, kind) {
      claims.push({ kind, date: month });
      return opts.claimable ?? true;
    },
    listActorsByProject: async () => [],
    async listByProject() {
      if (opts.monthError) {
        throw opts.monthError;
      }
      return opts.month ?? [];
    },
    listByDateRange: async () => [],
  };
  return {
    deps: {
      usage,
      ...(opts.withSlack === false
        ? {}
        : {
            // The composition root's closure, emulated: resolve the project's
            // own token, or report that it has no notification path.
            postAlert: async (target, destination, text) => {
              if (destination.kind !== "slack" || !target.slack?.enabled) {
                throw new Error("destination is unavailable");
              }
              posted.push({
                token: target.slack.botToken.replace("enc:", ""),
                channel: destination.channelId,
                text,
              });
            },
          }),
    },
    claims,
    posted,
  };
}

describe("secondsUntilUtcMidnight", () => {
  it("counts to the next UTC midnight", () => {
    expect(secondsUntilUtcMidnight(new Date("2026-07-29T23:59:00Z"))).toBe(60);
    expect(secondsUntilUtcMidnight(new Date("2026-07-29T00:00:00Z"))).toBe(86_400);
  });

  it("never tells a caller to retry immediately", () => {
    // At the boundary itself the naive answer is 0, which is an instruction to
    // retry into the same refusal.
    expect(secondsUntilUtcMidnight(new Date("2026-07-29T23:59:59.999Z"))).toBe(1);
  });
});

describe("assertWithinCostLimit", () => {
  it("allows a project with no limits without reading usage", async () => {
    const f = fixture({ dayError: new Error("must not be read") });
    await expect(assertWithinCostLimit(f.deps, project())).resolves.toBeUndefined();
  });

  it("allows spend below the block threshold", async () => {
    const f = fixture({ day: row({ "openai/gpt-5-mini": 4.5 }) });
    await expect(
      assertWithinCostLimit(f.deps, project({ blockThresholdUsd: 10 })),
    ).resolves.toBeUndefined();
  });

  it("refuses once spend reaches the block threshold, summing every model", async () => {
    const f = fixture({ day: row({ "openai/gpt-5-mini": 6, "google/gemini-3.1-flash-lite": 4.5 }) });
    await expect(
      assertWithinCostLimit(f.deps, project({ blockThresholdUsd: 10 }), new Date("2026-07-29T23:00:00Z")),
    ).rejects.toBeInstanceOf(CostLimitExceededError);
  });

  it("carries a 429 and the seconds until the window rolls over", async () => {
    const f = fixture({ day: row({ m: 12 }) });
    const thrown = await assertWithinCostLimit(
      f.deps,
      project({ blockThresholdUsd: 10 }),
      new Date("2026-07-29T23:00:00Z"),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(CostLimitExceededError);
    const error = thrown as CostLimitExceededError;
    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBe(3600);
    expect(error.message).toContain("$12.00 of $10.00");
  });

  it("an alert threshold alone never blocks", async () => {
    const f = fixture({ day: row({ m: 999 }) });
    await expect(
      assertWithinCostLimit(f.deps, project({ alertThresholdUsd: 1 })),
    ).resolves.toBeUndefined();
  });

  it("refuses once the month's summed rows reach the monthly block threshold", async () => {
    const { deps } = fixture({ month: [row({ m: 6 }), row({ m: 5 })] });
    await expect(
      assertWithinCostLimit(deps, project({ monthlyBlockThresholdUsd: 10 })),
    ).rejects.toThrow(CostLimitExceededError);
  });

  it("allows monthly spend below the monthly block threshold", async () => {
    const { deps } = fixture({ month: [row({ m: 4 })] });
    await expect(
      assertWithinCostLimit(deps, project({ monthlyBlockThresholdUsd: 10 })),
    ).resolves.toBeUndefined();
  });

  it("a monthly refusal waits for the month, not midnight", async () => {
    const { deps } = fixture({ day: row({ m: 20 }), month: [row({ m: 20 })] });
    const now = new Date("2026-08-09T12:00:00Z");
    // Both windows are crossed; the monthly Retry-After is the one that is true.
    const refusal = await assertWithinCostLimit(
      deps,
      project({ blockThresholdUsd: 10, monthlyBlockThresholdUsd: 15 }),
      now,
    ).then(
      () => null,
      (error: CostLimitExceededError) => error,
    );
    expect(refusal).toBeInstanceOf(CostLimitExceededError);
    expect(refusal?.window).toBe("monthly");
    const monthEnd = Math.ceil((Date.UTC(2026, 8, 1) - now.getTime()) / 1000);
    expect(refusal?.retryAfterSeconds).toBe(monthEnd);
  });

  it("fails open when the monthly usage read fails", async () => {
    const { deps } = fixture({ monthError: new Error("boom") });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      assertWithinCostLimit(deps, project({ monthlyBlockThresholdUsd: 1 })),
    ).resolves.toBeUndefined();
    error.mockRestore();
  });

  it("fails open when the usage read fails", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fixture({ dayError: new Error("dynamo down") });
    await expect(
      assertWithinCostLimit(f.deps, project({ blockThresholdUsd: 1 })),
    ).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it("a failed month read does not silence the daily check", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = fixture({ monthError: new Error("throttled"), day: row({ m: 400 }) });
    const refusal = await assertWithinCostLimit(
      deps,
      project({ blockThresholdUsd: 50, monthlyBlockThresholdUsd: 500 }),
    ).then(
      () => null,
      (e: CostLimitExceededError) => e,
    );
    // The month query failing open must not admit a run the daily window refuses.
    expect(refusal).toBeInstanceOf(CostLimitExceededError);
    expect(refusal?.window).toBe("daily");
    error.mockRestore();
  });

  it("refuses on the daily threshold from the month's rows without a second read", async () => {
    const { deps } = fixture({ dayError: new Error("must not be read"), month: [row({ m: 20 })] });
    const refusal = await assertWithinCostLimit(
      deps,
      project({ blockThresholdUsd: 10, monthlyBlockThresholdUsd: 100 }),
    ).then(
      () => null,
      (e: CostLimitExceededError) => e,
    );
    expect(refusal).toBeInstanceOf(CostLimitExceededError);
    expect(refusal?.window).toBe("daily");
  });
});

describe("settleCostLimit", () => {
  it("claims and posts once when the alert threshold is crossed", async () => {
    const f = fixture({ day: row({ m: 5 }) });
    await settleCostLimit(
      f.deps,
      project({ alertThresholdUsd: 4, alertSlackChannel: "C1" }, true),
    );
    expect(f.claims).toEqual([{ kind: "alert", date: today() }]);
    expect(f.posted).toHaveLength(1);
    expect(f.posted[0]).toMatchObject({ token: "token", channel: "C1" });
    expect(f.posted[0]?.text).toContain("$5.00 of $4.00");
  });

  it("attempts every selected platform even when one delivery fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fixture({ day: row({ m: 5 }) });
    const delivered: string[] = [];
    f.deps.postAlert = async (_target, destination) => {
      delivered.push(destination.kind);
      if (destination.kind === "telegram") {
        throw new Error("telegram unavailable");
      }
    };
    await settleCostLimit(
      f.deps,
      project({
        alertThresholdUsd: 4,
        alertDestinations: [
          { kind: "slack", channelId: "C1" },
          { kind: "telegram", chatId: -1001 },
          { kind: "teams", conversationId: "19:one" },
        ],
      }),
    );
    expect(delivered).toEqual(["slack", "telegram", "teams"]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("does not post when the claim was already taken today", async () => {
    const f = fixture({ day: row({ m: 5 }), claimable: false });
    await settleCostLimit(
      f.deps,
      project({ alertThresholdUsd: 4, alertSlackChannel: "C1" }, true),
    );
    expect(f.claims).toHaveLength(1);
    expect(f.posted).toHaveLength(0);
  });

  it("claims each threshold separately so a block does not swallow the alert", async () => {
    const f = fixture({ day: row({ m: 20 }) });
    await settleCostLimit(
      f.deps,
      project({ alertThresholdUsd: 5, blockThresholdUsd: 10, alertSlackChannel: "C1" }, true),
    );
    expect(f.claims.map((c) => c.kind)).toEqual(["block", "alert"]);
    expect(f.posted).toHaveLength(2);
    expect(f.posted[0]?.text).toContain("reached its daily cost limit");
    expect(f.posted[1]?.text).toContain("alert threshold");
  });

  it("claims the monthly threshold on the month, not a day", async () => {
    const { deps, claims, posted } = fixture({
      month: [row({ m: 12 })],
      withSlack: true,
    });
    await settleCostLimit(
      deps,
      project({ monthlyAlertThresholdUsd: 10, alertSlackChannel: "C123" }, true),
    );
    expect(claims).toEqual([{ kind: "alert", date: today().slice(0, 7) }]);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.text).toContain("monthly");
  });

  it("settles a monthly-only project without reading the day row", async () => {
    const f = fixture({ dayError: new Error("must not be read"), month: [row({ m: 12 })] });
    await settleCostLimit(
      f.deps,
      project({ monthlyAlertThresholdUsd: 10, alertSlackChannel: "C1" }, true),
    );
    expect(f.claims).toEqual([{ kind: "alert", date: today().slice(0, 7) }]);
  });

  it("derives the day from the month's rows rather than reading twice", async () => {
    const f = fixture({ dayError: new Error("must not be read"), month: [row({ m: 20 })] });
    await settleCostLimit(
      f.deps,
      project({ alertThresholdUsd: 5, monthlyAlertThresholdUsd: 100, alertSlackChannel: "C1" }, true),
    );
    // The daily alert fired from the month's rows; `getDay` was never called.
    expect(f.claims).toEqual([{ kind: "alert", date: today() }]);
  });

  it("a failed month read does not swallow the daily notification", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // The month query fails; the daily window falls back to its own read and
    // still announces its crossed threshold.
    const f = fixture({ monthError: new Error("boom"), day: row({ m: 5 }) });
    await settleCostLimit(
      f.deps,
      project(
        { alertThresholdUsd: 4, monthlyAlertThresholdUsd: 100, alertSlackChannel: "C1" },
        true,
      ),
    );
    expect(f.claims).toEqual([{ kind: "alert", date: today() }]);
    error.mockRestore();
  });

  it("stays silent below every threshold", async () => {
    const f = fixture({ day: row({ m: 1 }) });
    await settleCostLimit(f.deps, project({ alertThresholdUsd: 5, blockThresholdUsd: 10 }, true));
    expect(f.claims).toHaveLength(0);
    expect(f.posted).toHaveLength(0);
  });

  it("still claims — and therefore still records — with no channel configured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fixture({ day: row({ m: 5 }) });
    await settleCostLimit(f.deps, project({ alertThresholdUsd: 4 }, true));
    expect(f.claims).toHaveLength(1);
    expect(f.posted).toHaveLength(0);
    warn.mockRestore();
  });

  it("never throws when the notification fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps: CostGuardDeps = {
      usage: {
        record: async () => {},
        getDay: async () => row({ m: 5 }),
        listMemberDays: async () => [],
        claimAlert: async () => true,
        claimMonthAlert: async () => true,
        listActorsByProject: async () => [],
    listByProject: async () => [],
        listByDateRange: async () => [],
      },
      postAlert: async () => {
        throw new Error("slack is down");
      },
    };
    await expect(
      settleCostLimit(deps, project({ alertThresholdUsd: 1, alertSlackChannel: "C1" }, true)),
    ).resolves.toBeUndefined();
    error.mockRestore();
  });
});

describe("every top-level entry point is guarded", () => {
  /**
   * The six route-level entry points (predict, chat/completions, agent, chat,
   * Slack, A2A) all reach one of these four functions, and image generation is
   * the fifth. Every other dependency rejects, so a run that got past the guard
   * fails loudly rather than quietly succeeding on a fake.
   */
  function blockedDeps() {
    const reject = () => Promise.reject(new Error("the guard should have refused first"));
    const f = fixture({ day: row({ m: 100 }) });
    return {
      ...f.deps,
      projects: { get: reject, list: reject, put: reject, delete: reject },
      versions: { get: reject, list: reject, put: reject, delete: reject },
      skills: fakeSkillRepository(reject),
      mcps: { get: reject, list: reject, put: reject, delete: reject },
      externalAgents: { get: reject, list: reject, put: reject, delete: reject },
      channel: { stream: reject },
      imageChannel: { generateImage: reject, editImage: reject },
    } as unknown as ExecutionDeps;
  }

  const blocked = project({ blockThresholdUsd: 10 });
  const version: Version = {
    projectName: "proj",
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

  it("executeProject refuses", async () => {
    await expect(
      executeProject(blockedDeps(), { project: blocked, version, messages: [] }),
    ).rejects.toBeInstanceOf(CostLimitExceededError);
  });

  it("executeProjectStream refuses before the first chunk", async () => {
    const stream = executeProjectStream(blockedDeps(), { project: blocked, version, messages: [] });
    await expect(stream.next()).rejects.toBeInstanceOf(CostLimitExceededError);
  });

  it("executeAgent refuses before the first chunk", async () => {
    const stream = executeAgent(blockedDeps(), { project: blocked, version, messages: [] });
    await expect(stream.next()).rejects.toBeInstanceOf(CostLimitExceededError);
  });

  it("guards an Agent that enables image tools before any image call", async () => {
    await expect(executeProject(blockedDeps(), { project: blocked,
      version: { ...version, parameters: { piiFiltering: false, imageGeneration: true } },
      messages: [{ role: "user", content: "Draw a cat" }],
    })).rejects.toBeInstanceOf(CostLimitExceededError);
  });

  it("a refused run records no usage and opens no trace", async () => {
    resetRunMetrics();
    const deps = blockedDeps();
    const traces: unknown[] = [];
    deps.traces = { put: async (t: unknown) => void traces.push(t) } as ExecutionDeps["traces"];

    await expect(executeProject(deps, { project: blocked, version, messages: [] })).rejects.toBeInstanceOf(
      CostLimitExceededError,
    );
    expect(traces).toHaveLength(0);
    expect(runMetricsSnapshot()).toMatchObject({ activeRuns: 0, runsStarted: 0 });
  });
});

describe("a subagent transfer is guarded too", () => {
  /**
   * A transfer never opens a bracket — it is not a top-level run — but it *is* a
   * whole run on another project, with its own tool loop and its own usage rows.
   * Nothing else ever asks whether that project may spend, so a child at its
   * threshold ran anyway on the strength of its parent's admission.
   */
  const child = project({ blockThresholdUsd: 10 });
  const childVersion: Version = {
    projectName: "proj",
    versionName: "v1",
    systemPrompt: "",
    userPromptTemplate: "",
    model: "openai/gpt-5-mini",
    parameters: { piiFiltering: false },
    mcpList: [],
    skillList: [],
    subagentList: [],
    createdAt: "2026-01-01T00:00:00Z",
    publishedVersion: undefined,
  } as Version;

  function deps(spentUsd: number) {
    const f = fixture({ day: row({ m: spentUsd }) });
    return {
      ...f.deps,
      projects: { get: async () => ({ ...child, projectType: "agent", publishedVersion: "v1" }) },
      versions: { get: async () => childVersion },
      channel: {
        stream: () => {
          throw new Error("the guard should have refused before the channel");
        },
      },
    } as unknown as ExecutionDeps;
  }

  function prepareChild(spentUsd: number) {
    return prepareSubagent(deps(spentUsd), { ...childVersion, projectName: "parent", subagentList: [{ name: "proj", type: "local" }] }, "proj", { message: "hi", images: [] }, async () => {}, { ancestry: ["parent"] });
  }
  it("refuses a child over its own project spending limit", async () => {
    await expect(prepareChild(100)).rejects.toThrow(/daily|limit|spend/i);
  });
  it("prepares a child under its project spending limit", async () => {
    expect(await prepareChild(1)).toMatchObject({ kind: "agent", input: { model: childVersion.model } });
  });
});

describe("openRun", () => {
  /** Minimal version; the bracket reads only its model ids. */
  const version: Version = {
    projectName: "proj",
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

  it("does not count a run the guard refused", async () => {
    resetRunMetrics();
    const f = fixture({ day: row({ m: 50 }) });
    await expect(openRun(f.deps, project({ blockThresholdUsd: 10 }), version)).rejects.toBeInstanceOf(
      CostLimitExceededError,
    );
    expect(runMetricsSnapshot()).toMatchObject({ activeRuns: 0, runsStarted: 0 });
  });

  it("counts an admitted run and releases it exactly once", async () => {
    resetRunMetrics();
    const f = fixture({ day: null });
    const bracket = await openRun(f.deps, project({ blockThresholdUsd: 10 }), version);
    expect(runMetricsSnapshot().activeRuns).toBe(1);
    await bracket.close();
    // A generator reaches its `finally` through both a return and a consumer's
    // `return()`; a second decrement would understate load forever.
    await bracket.close();
    expect(runMetricsSnapshot()).toMatchObject({ activeRuns: 0, runsFinished: 1 });
  });
});
