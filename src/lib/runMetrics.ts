/**
 * In-process run counters, exposed by `/api/metrics` for autoscaling and alerting.
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
 *
 * Nothing here is labelled by agent, user or model — the same rule the
 * unknown-model counter follows. A label whose values are unbounded turns one
 * metric into a time series per value, and none of these questions need one.
 */

/**
 * Duration buckets, in seconds, cumulative as Prometheus histograms are.
 *
 * Chosen for the shape of this workload rather than a default ladder: a chat
 * turn is seconds, a multi-turn agent run is tens of seconds to minutes, and the
 * default hard deadline is 600s — so the top finite bucket matches the default.
 * The bucket stays fixed when `MAX_RUN_DURATION_MS` is overridden, so anything
 * beyond it is not necessarily a run that outlived its configured limit.
 */
export const DURATION_BUCKETS_SECONDS = [0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600];

const activeRunStarts = new Map<symbol, number>();
let runsStarted = 0;
let runsFinished = 0;
let runsFailed = 0;
let durationSumSeconds = 0;
let durationObservations = 0;
let bucketCounts = new Array<number>(DURATION_BUCKETS_SECONDS.length).fill(0);

export interface RunMetricHandle {
  readonly id: symbol;
}

/** Call when a top-level run starts; pair its handle with {@link endRun} in a `finally`. */
export function beginRun(startedAtMs = Date.now()): RunMetricHandle {
  const handle = { id: Symbol("runMetric") };
  activeRunStarts.set(handle.id, startedAtMs);
  runsStarted += 1;
  return handle;
}

/**
 * Call when a top-level run ends, however it ended.
 *
 * `failed` is the signal to alert on: the gauge says how busy an instance is and
 * nothing about whether the work is succeeding. A cancelled run — a client that
 * hung up — is not a failure and must not be counted as one, or a page full of
 * users navigating away reads as an outage.
 */
export function endRun(
  handle: RunMetricHandle,
  outcome: { durationMs?: number; failed?: boolean } = {},
): void {
  if (!activeRunStarts.delete(handle.id)) {
    return;
  }
  runsFinished += 1;
  if (outcome.failed) {
    runsFailed += 1;
  }
  if (outcome.durationMs !== undefined) {
    const seconds = outcome.durationMs / 1000;
    durationSumSeconds += seconds;
    durationObservations += 1;
    for (const [index, bound] of DURATION_BUCKETS_SECONDS.entries()) {
      if (seconds <= bound) {
        bucketCounts[index] = (bucketCounts[index] ?? 0) + 1;
      }
    }
  }
}

export interface RunMetricsSnapshot {
  activeRuns: number;
  runsStarted: number;
  runsFinished: number;
  runsFailed: number;
  durationSumSeconds: number;
  /** Cumulative counts aligned with {@link DURATION_BUCKETS_SECONDS}. */
  durationBuckets: number[];
  /** Every observation — the histogram's `_count` and its `+Inf` bucket. */
  durationCount: number;
  /** Age of the oldest in-flight run, or zero when the instance is idle. */
  oldestActiveRunSeconds: number;
}

export function runMetricsSnapshot(nowMs = Date.now()): RunMetricsSnapshot {
  const oldestStartedAt = activeRunStarts.size > 0 ? Math.min(...activeRunStarts.values()) : nowMs;
  return {
    activeRuns: activeRunStarts.size,
    runsStarted,
    runsFinished,
    runsFailed,
    durationSumSeconds,
    durationBuckets: [...bucketCounts],
    durationCount: durationObservations,
    oldestActiveRunSeconds: Math.max(0, (nowMs - oldestStartedAt) / 1000),
  };
}

/** Test seam — production code never resets counters. */
export function resetRunMetrics(): void {
  activeRunStarts.clear();
  runsStarted = 0;
  runsFinished = 0;
  runsFailed = 0;
  durationSumSeconds = 0;
  durationObservations = 0;
  bucketCounts = new Array<number>(DURATION_BUCKETS_SECONDS.length).fill(0);
}
