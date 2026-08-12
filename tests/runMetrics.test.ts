import { beforeEach, describe, expect, it } from "vitest";
import { beginRun, endRun, resetRunMetrics, runMetricsSnapshot } from "@/lib/runMetrics";
import { GET } from "@/app/api/metrics/route";

beforeEach(() => {
  resetRunMetrics();
});

describe("run metrics", () => {
  it("tracks concurrent runs as a gauge and arrivals as a total", () => {
    beginRun();
    beginRun();
    expect(runMetricsSnapshot()).toMatchObject({
      activeRuns: 2,
      runsStarted: 2,
      runsFinished: 0,
    });

    endRun();
    expect(runMetricsSnapshot()).toMatchObject({
      activeRuns: 1,
      runsStarted: 2,
      runsFinished: 1,
    });
  });

  /**
   * The gauge drives autoscaling, so it must never read below the truth — a
   * negative gauge would tell the autoscaler an overloaded fleet is empty.
   */
  it("never lets the active gauge go negative", () => {
    endRun();
    endRun();
    expect(runMetricsSnapshot().activeRuns).toBe(0);
  });
});

describe("GET /api/metrics", () => {
  it("renders the Prometheus text exposition format", async () => {
    beginRun();
    const response = GET();

    expect(response.headers.get("Content-Type")).toContain("text/plain");
    const body = await response.text();
    expect(body).toContain("# TYPE agentdure_active_runs gauge");
    expect(body).toContain("agentdure_active_runs 1");
    expect(body).toContain("agentdure_runs_started_total 1");
    expect(body).toMatch(/\n$/);
  });

  it("reports whether the instance is draining", async () => {
    const body = await GET().text();
    expect(body).toContain("agentdure_draining 0");
  });
});
