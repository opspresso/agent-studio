import { unknownModelSnapshot } from "@/domain/llm/models";
import { DURATION_BUCKETS_SECONDS, runMetricsSnapshot } from "@/lib/runMetrics";
import { isShuttingDown } from "@/shared/lifecycle";

/**
 * Prometheus scrape endpoint, for autoscaling on in-flight runs.
 *
 * Runs are I/O bound — an instance saturated with them still reads as idle CPU —
 * so `agent_studio_active_runs` is the signal an autoscaler should key on, not
 * CPU utilization. See `src/lib/runMetrics.ts`.
 *
 * `agent_studio_runs_failed_total` and the duration histogram are the alerting
 * signals: the gauge says how busy an instance is and nothing about whether the
 * work is succeeding or how long it now takes.
 *
 * `agent_studio_unknown_model_calls_total` is a correctness signal rather than a
 * scaling one: a model id missing from the registry still runs, but its usage is
 * booked at $0, so the miss is invisible in the cost dashboard it corrupts. It
 * belongs here because that is where a non-zero rate gets noticed.
 *
 * Unauthenticated and dependency-free, like `/api/health`: it is scraped
 * in-cluster on the pod address, and it exposes only process-wide counts — no
 * project, user, or model is named.
 */
export function GET(): Response {
  const {
    activeRuns,
    runsStarted,
    runsFinished,
    runsFailed,
    durationSumSeconds,
    durationBuckets,
    durationCount,
  } = runMetricsSnapshot();
  const unknownModels = unknownModelSnapshot();
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
    "# HELP agent_studio_runs_failed_total Top-level runs that ended with an error. Cancellations are not failures.",
    "# TYPE agent_studio_runs_failed_total counter",
    `agent_studio_runs_failed_total ${runsFailed}`,
    "# HELP agent_studio_run_duration_seconds How long top-level runs took.",
    "# TYPE agent_studio_run_duration_seconds histogram",
    ...DURATION_BUCKETS_SECONDS.map(
      (bound, index) =>
        `agent_studio_run_duration_seconds_bucket{le="${bound}"} ${durationBuckets[index] ?? 0}`,
    ),
    `agent_studio_run_duration_seconds_bucket{le="+Inf"} ${durationCount}`,
    `agent_studio_run_duration_seconds_sum ${durationSumSeconds}`,
    `agent_studio_run_duration_seconds_count ${durationCount}`,
    "# HELP agent_studio_unknown_model_calls_total Cost calculations for a model id missing from the registry, each booked at $0.",
    "# TYPE agent_studio_unknown_model_calls_total counter",
    `agent_studio_unknown_model_calls_total ${unknownModels.calls}`,
    "# HELP agent_studio_unknown_models Distinct model ids seen by this process that are missing from the registry.",
    "# TYPE agent_studio_unknown_models gauge",
    `agent_studio_unknown_models ${unknownModels.models}`,
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
