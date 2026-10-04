import { expect, it, vi } from "vitest";

it("shares run and native Gateway load between separately loaded server modules", async () => {
  const runs = await import("@/lib/runMetrics");
  const native = await import("@/lib/workspaceModelMetrics");
  runs.resetRunMetrics();
  const handle = runs.beginRun(1_000);
  const release = native.beginWorkspaceModelRequest();
  try {
    vi.resetModules();
    const otherRuns = await import("@/lib/runMetrics");
    const otherNative = await import("@/lib/workspaceModelMetrics");
    expect(otherRuns.runMetricsSnapshot(2_000)).toMatchObject({ activeRuns: 1, oldestActiveRunSeconds: 1 });
    expect(otherNative.activeWorkspaceModelRequests()).toBe(1);
    otherRuns.endRun(handle, { durationMs: 1_000 });
    release();
    release();
    expect(runs.runMetricsSnapshot(2_000)).toMatchObject({ activeRuns: 0, runsFinished: 1 });
    expect(otherNative.activeWorkspaceModelRequests()).toBe(0);
  } finally { runs.endRun(handle); runs.resetRunMetrics(); release(); }
});
