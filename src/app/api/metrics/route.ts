import { runMetricsSnapshot } from "@/lib/runMetrics";
import { isShuttingDown } from "@/shared/lifecycle";

/**
 * Prometheus scrape endpoint, for autoscaling on in-flight runs.
 *
 * Runs are I/O bound — an instance saturated with them still reads as idle CPU —
 * so `agent_studio_active_runs` is the signal an autoscaler should key on, not
 * CPU utilization. See `src/lib/runMetrics.ts`.
 *
 * Unauthenticated and dependency-free, like `/api/health`: it is scraped
 * in-cluster on the pod address, and it exposes only process-wide counts — no
 * project, user, or model is named.
 */
export function GET(): Response {
  const { activeRuns, runsStarted, runsFinished } = runMetricsSnapshot();
  const body = [
    "# HELP agent_studio_active_runs Top-level runs currently executing on this instance.",
    "# TYPE agent_studio_active_runs gauge",
    `agent_studio_active_runs ${activeRuns}`,
    "# HELP agent_studio_runs_started_total Top-level runs started since process start.",
    "# TYPE agent_studio_runs_started_total counter",
    `agent_studio_runs_started_total ${runsStarted}`,
    "# HELP agent_studio_runs_finished_total Top-level runs finished since process start.",
    "# TYPE agent_studio_runs_finished_total counter",
    `agent_studio_runs_finished_total ${runsFinished}`,
    "# HELP agent_studio_draining Whether this instance has begun shutting down.",
    "# TYPE agent_studio_draining gauge",
    `agent_studio_draining ${isShuttingDown() ? 1 : 0}`,
    "",
  ].join("\n");

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
