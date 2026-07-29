import { describe, expect, it, vi } from "vitest";
import {
  assertWithinCostLimit,
  CostLimitExceededError,
  secondsUntilUtcMidnight,
  settleCostLimit,
  type CostGuardDeps,
} from "@/application/usage/costGuard";
import { openRun } from "@/application/execution/runBracket";
import {
  executeAgent,
  executeVersion,
  executeVersionStream,
  type ExecutionDeps,
} from "@/application/execution/runProject";
import { generateImage, type ImageGenerationDeps } from "@/application/image/generateImage";
import { MODEL_CONFIGS } from "@/domain/llm/models";
import { resetRunMetrics, runMetricsSnapshot } from "@/lib/runMetrics";
import type { CostLimits, Project, Version } from "@/domain/project/types";
import type { CostAlertKind, UsageRepository } from "@/domain/usage/repository";
import type { UsageRow } from "@/domain/usage/types";

const TODAY = new Date().toISOString().slice(0, 10);

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
    date: TODAY,
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
    async claimAlert(_projectName, date, kind) {
      claims.push({ kind, date });
      return opts.claimable ?? true;
    },
    listByProject: async () => [],
    listByDateRange: async () => [],
  };
  return {
    deps: {
      usage,
      cipher: { decrypt: (value: string) => value.replace("enc:", "") } as CostGuardDeps["cipher"],
      ...(opts.withSlack === false
        ? {}
        : {
            slack: {
              async postMessage(token, args) {
                posted.push({ token, ...args });
                return { ts: "1", channel: args.channel };
              },
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

  it("fails open when the usage read fails", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fixture({ dayError: new Error("dynamo down") });
    await expect(
      assertWithinCostLimit(f.deps, project({ blockThresholdUsd: 1 })),
    ).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe("settleCostLimit", () => {
  it("claims and posts once when the alert threshold is crossed", async () => {
    const f = fixture({ day: row({ m: 5 }) });
    await settleCostLimit(
      f.deps,
      project({ alertThresholdUsd: 4, alertSlackChannel: "C1" }, true),
    );
    expect(f.claims).toEqual([{ kind: "alert", date: TODAY }]);
    expect(f.posted).toHaveLength(1);
    expect(f.posted[0]).toMatchObject({ token: "token", channel: "C1" });
    expect(f.posted[0]?.text).toContain("$5.00 of $4.00");
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
        claimAlert: async () => true,
        listByProject: async () => [],
        listByDateRange: async () => [],
      },
      cipher: { decrypt: (v: string) => v } as CostGuardDeps["cipher"],
      slack: {
        postMessage: async () => {
          throw new Error("slack is down");
        },
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
      skills: { get: reject, list: reject, put: reject, delete: reject },
      mcps: { get: reject, list: reject, put: reject, delete: reject },
      externalAgents: { get: reject, list: reject, put: reject, delete: reject },
      channel: { stream: reject },
      imageChannel: { generateImage: reject, editImage: reject },
    } as unknown as ExecutionDeps & ImageGenerationDeps;
  }

  const blocked = project({ blockThresholdUsd: 10 });
  const version: Version = {
    projectName: "proj",
    versionName: "v1",
    systemPrompt: "",
    userPromptTemplate: "",
    // An image-capable model, so `generateImage` reaches the guard rather than
    // being turned away by its capability check first.
    model: MODEL_CONFIGS.find((m) => m.capabilities.imageGeneration)?.id ?? "openai/gpt-image-2",
    parameters: { piiFiltering: false },
    mcpList: [],
    skillList: [],
    subagentList: [],
    createdAt: "2026-01-01T00:00:00Z",
  };

  it("executeVersion refuses", async () => {
    await expect(
      executeVersion(blockedDeps(), { project: blocked, version }),
    ).rejects.toBeInstanceOf(CostLimitExceededError);
  });

  it("executeVersionStream refuses before the first chunk", async () => {
    const stream = executeVersionStream(blockedDeps(), { project: blocked, version });
    await expect(stream.next()).rejects.toBeInstanceOf(CostLimitExceededError);
  });

  it("executeAgent refuses before the first chunk", async () => {
    const stream = executeAgent(blockedDeps(), { project: blocked, version, messages: [] });
    await expect(stream.next()).rejects.toBeInstanceOf(CostLimitExceededError);
  });

  it("generateImage refuses", async () => {
    await expect(
      generateImage(blockedDeps(), { project: blocked, version, prompt: "a cat" }),
    ).rejects.toBeInstanceOf(CostLimitExceededError);
  });

  it("a refused run records no usage and opens no trace", async () => {
    resetRunMetrics();
    const deps = blockedDeps();
    const traces: unknown[] = [];
    deps.traces = { put: async (t: unknown) => void traces.push(t) } as ExecutionDeps["traces"];
    deps.traceSampleRate = 1;
    await expect(executeVersion(deps, { project: blocked, version })).rejects.toBeInstanceOf(
      CostLimitExceededError,
    );
    expect(traces).toHaveLength(0);
    expect(runMetricsSnapshot()).toMatchObject({ activeRuns: 0, runsStarted: 0 });
  });
});

describe("openRun", () => {
  it("does not count a run the guard refused", async () => {
    resetRunMetrics();
    const f = fixture({ day: row({ m: 50 }) });
    await expect(openRun(f.deps, project({ blockThresholdUsd: 10 }))).rejects.toBeInstanceOf(
      CostLimitExceededError,
    );
    expect(runMetricsSnapshot()).toMatchObject({ activeRuns: 0, runsStarted: 0 });
  });

  it("counts an admitted run and releases it exactly once", async () => {
    resetRunMetrics();
    const f = fixture({ day: null });
    const bracket = await openRun(f.deps, project({ blockThresholdUsd: 10 }));
    expect(runMetricsSnapshot().activeRuns).toBe(1);
    await bracket.close();
    // A generator reaches its `finally` through both a return and a consumer's
    // `return()`; a second decrement would understate load forever.
    await bracket.close();
    expect(runMetricsSnapshot()).toMatchObject({ activeRuns: 0, runsFinished: 1 });
  });
});
