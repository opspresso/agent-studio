import { beforeEach, describe, expect, it } from "vitest";
import { beginRun, endRun, resetRunMetrics, runMetricsSnapshot } from "@/lib/runMetrics";
import { GET } from "@/app/api/metrics/route";

beforeEach(() => {
  resetRunMetrics();
});

describe("run metrics", () => {
  it("tracks concurrent runs as a gauge and arrivals as a total", () => {
    const first = beginRun();
    beginRun();
    expect(runMetricsSnapshot()).toMatchObject({
      activeRuns: 2,
      runsStarted: 2,
      runsFinished: 0,
    });

    endRun(first);
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
    const run = beginRun();
    endRun(run);
    endRun(run);
    expect(runMetricsSnapshot().activeRuns).toBe(0);
  });

  it("keeps the oldest active age when a newer run finishes first", () => {
    const oldest = beginRun(1_000);
    const newer = beginRun(4_000);

    expect(runMetricsSnapshot(7_000).oldestActiveRunSeconds).toBe(6);
    endRun(newer);
    expect(runMetricsSnapshot(7_000).oldestActiveRunSeconds).toBe(6);
    endRun(oldest);
    expect(runMetricsSnapshot(7_000).oldestActiveRunSeconds).toBe(0);
  });
});

describe("GET /api/metrics", () => {
  it("renders the Prometheus text exposition format", async () => {
    beginRun();
    const response = GET();

    expect(response.headers.get("Content-Type")).toContain("text/plain");
    const body = await response.text();
    expect(body).toContain("# TYPE agent_studio_active_runs gauge");
    expect(body).toContain("agent_studio_active_runs 1");
    expect(body).toContain("agent_studio_runs_started_total 1");
    expect(body).toMatch(/\n$/);
  });

  it("reports whether the instance is draining", async () => {
    const body = await GET().text();
    expect(body).toContain("agent_studio_draining 0");
  });

  it("reports bounded build and Node.js process metrics", async () => {
    const body = await GET().text();
    expect(body).toMatch(/agent_studio_build_info\{version="[^"]+",stage="(?:local|alpha|prod)"\} 1/);
    expect(body).toMatch(/process_resident_memory_bytes \d+/);
    expect(body).toMatch(/process_cpu_seconds_total \d+(?:\.\d+)?/);
    expect(body).toMatch(/nodejs_heap_size_used_bytes \d+/);
    expect(body).toMatch(/nodejs_eventloop_delay_p95_seconds \d+(?:\.\d+)?/);
    expect(body).toMatch(/nodejs_eventloop_delay_max_seconds \d+(?:\.\d+)?/);
  });
});
