/**
 * In-process run counters, exposed by `/api/metrics` for autoscaling.
 *
 * This workload is I/O bound: a run holds its connection open while it waits on
 * the LLM provider and the tools it calls, at near-zero CPU. CPU utilization
 * therefore says almost nothing about how loaded an instance is — an instance
 * saturated with in-flight runs looks idle. Autoscaling has to key on the number
 * of runs in flight instead, so that number has to be observable.
 *
 * Counters are per-process and reset on restart, which is what a scrape-based
 * collector expects: the gauge is read as-is, and the totals are only ever used
 * as rates, where a reset reads as a counter restart.
 *
 * Only top-level runs are counted. Subagent transfers execute inside their
 * parent's run and would otherwise inflate the gauge with work that consumes no
 * additional connection.
 */

let activeRuns = 0;
let runsStarted = 0;
let runsFinished = 0;

/** Call when a top-level run starts; pair with {@link endRun} in a `finally`. */
export function beginRun(): void {
  activeRuns += 1;
  runsStarted += 1;
}

/** Call when a top-level run ends, however it ended. */
export function endRun(): void {
  // Clamped: a stray extra end would otherwise drive the gauge negative and
  // permanently understate load to the autoscaler.
  activeRuns = Math.max(0, activeRuns - 1);
  runsFinished += 1;
}

export interface RunMetricsSnapshot {
  activeRuns: number;
  runsStarted: number;
  runsFinished: number;
}

export function runMetricsSnapshot(): RunMetricsSnapshot {
  return { activeRuns, runsStarted, runsFinished };
}

/** Test seam — production code never resets counters. */
export function resetRunMetrics(): void {
  activeRuns = 0;
  runsStarted = 0;
  runsFinished = 0;
}
