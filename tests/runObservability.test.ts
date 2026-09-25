import { describe, expect, it, vi } from "vitest";
import { log } from "@/shared/logger";
import { currentRunContext, linkTrace, withRunContext } from "@/shared/runContext";
import { openRun } from "@/application/run/runBracket";
import {
  DURATION_BUCKETS_SECONDS,
  endRun,
  beginRun,
  resetRunMetrics,
  runMetricsSnapshot,
} from "@/lib/runMetrics";
import { GET as metricsRoute } from "@/app/api/metrics/route";
import type { Agent, AgentConfiguration } from "@/domain/agent/types";
import type { UsageRepository } from "@/domain/usage/repository";

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

describe("run correlation", () => {
  it("stamps every line of a run with the same id", () => {
    const lines: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((line: string) => {
      lines.push(line);
    });
    withRunContext({ runId: "run-1" }, () => {
      log.warn("mcp", "first");
      log.warn("engine", "second");
    });
    warn.mockRestore();
    expect(lines).toEqual(["[mcp run=run-1] first", "[engine run=run-1] second"]);
  });

  it("works for a run with no trace, which sampling makes the common case", () => {
    // The reason the correlation id is not the trace id: nine out of ten prompt
    // and image runs are not sampled, and would have nothing to correlate on.
    const lines: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((line: string) => {
      lines.push(line);
    });
    withRunContext({ runId: "run-2" }, () => log.warn("run", "unsampled"));
    warn.mockRestore();
    expect(lines[0]).toBe("[run run=run-2] unsampled");
    expect(lines[0]).not.toContain("trace=");
  });

  it("links a trace once one exists, and keeps the first", () => {
    withRunContext({ runId: "run-3" }, () => {
      linkTrace("trace-a");
      // A subagent's recorder is constructed later; the run's own trace is the
      // one worth carrying.
      linkTrace("trace-b");
      expect(currentRunContext()?.traceId).toBe("trace-a");
    });
  });

  it("falls back to the bare scope outside a run", () => {
    const lines: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((line: string) => {
      lines.push(line);
    });
    log.error("boot", "no run here");
    error.mockRestore();
    expect(lines[0]).toBe("[boot] no run here");
  });

  it("gives an admitted run an id", async () => {
    resetRunMetrics();
    const bracket = await openRun({ usage }, agent, configuration);
    expect(bracket.runId).toMatch(/[0-9a-f-]{36}/);
    await bracket.close();
  });

  /**
   * The bug this pins: `openRun` entered the store *after* its first await, so
   * it bound to the bracket's own continuation and the caller — every line the
   * run actually produces — saw nothing. Every test here passed anyway, because
   * they all entered the store themselves. Assert from the caller's side.
   */
  it("is visible to the caller after openRun returns", async () => {
    resetRunMetrics();
    const bracket = await openRun({ usage }, agent, configuration);
    expect(currentRunContext()?.runId).toBe(bracket.runId);
    await bracket.close();
  });

  it("still carries the id at the end of the run, not just the start", async () => {
    resetRunMetrics();
    const bracket = await openRun({ usage }, agent, configuration);
    await Promise.resolve();
    linkTrace("trace-x");
    expect(currentRunContext()).toMatchObject({ runId: bracket.runId, traceId: "trace-x" });
    await bracket.close();
  });

  it("joins a scope background work already opened, rather than minting a second id", async () => {
    // `after()` leaves the request's async context, so a webhook delivery opens
    // its own scope with the id its history row shows. A fresh id underneath
    // would split one delivery's lines across two.
    resetRunMetrics();
    await withRunContext({ runId: "delivery-1" }, async () => {
      const bracket = await openRun({ usage }, agent, configuration);
      expect(bracket.runId).toBe("delivery-1");
      expect(currentRunContext()?.runId).toBe("delivery-1");
      await bracket.close();
    });
  });
});

describe("run metrics", () => {
  it("counts failures apart from cancellations", () => {
    resetRunMetrics();
    const failed = beginRun();
    endRun(failed, { failed: true });
    const cancelled = beginRun();
    // A client that hung up is not an outage.
    endRun(cancelled, { failed: false });
    const succeeded = beginRun();
    endRun(succeeded);
    expect(runMetricsSnapshot()).toMatchObject({ runsFinished: 3, runsFailed: 1 });
  });

  it("observes durations into cumulative buckets", () => {
    resetRunMetrics();
    const short = beginRun();
    endRun(short, { durationMs: 1_500 });
    const long = beginRun();
    endRun(long, { durationMs: 45_000 });
    const snapshot = runMetricsSnapshot();
    expect(snapshot.durationCount).toBe(2);
    expect(snapshot.durationSumSeconds).toBeCloseTo(46.5, 6);
    // Cumulative: the 2s bucket holds the 1.5s run, the 60s bucket holds both.
    const at = (bound: number) => snapshot.durationBuckets[DURATION_BUCKETS_SECONDS.indexOf(bound)];
    expect(at(1)).toBe(0);
    expect(at(2)).toBe(1);
    expect(at(60)).toBe(2);
  });

  it("does not observe a duration that was never measured", () => {
    resetRunMetrics();
    const run = beginRun();
    endRun(run, { failed: true });
    expect(runMetricsSnapshot().durationCount).toBe(0);
  });
});

describe("/api/metrics", () => {
  it("exposes the failure counter and a well-formed histogram", async () => {
    resetRunMetrics();
    const run = beginRun();
    endRun(run, { durationMs: 3_000, failed: true });
    const body = await metricsRoute().text();
    expect(body).toContain("agent_studio_runs_failed_total 1");
    expect(body).toContain("# TYPE agent_studio_run_duration_seconds histogram");
    expect(body).toContain('agent_studio_run_duration_seconds_bucket{le="5"} 1');
    expect(body).toContain('agent_studio_run_duration_seconds_bucket{le="+Inf"} 1');
    expect(body).toContain("agent_studio_run_duration_seconds_count 1");
  });

  it("names no agent, user or model in any label", async () => {
    resetRunMetrics();
    const run = beginRun();
    endRun(run, { durationMs: 1_000 });
    const body = await metricsRoute().text();
    // A label whose values are unbounded turns one metric into a series per
    // value — the same reason unknown models are counted rather than labelled.
    const labels = [...body.matchAll(/\{([^}]*)\}/g)].map((m) => m[1] ?? "");
    for (const label of labels) {
      expect(label).toMatch(/^(?:le="[^"]+"|version="[^"]+",stage="(?:local|alpha|prod)")$/);
    }
  });
});
