/** SDK response metadata written by Studio's model adapter, never by the provider. */
export const MODEL_DURATION_MS = "studioModelDurationMs";

export interface PerformanceTotals {
  modelDurationMs: number;
  timedOutputTokens: number;
  timedCalls: number;
}

/** Keep a matched numerator and denominator; untimed calls must not inflate throughput. */
export function performanceSample(outputTokens: number, durationMs?: number): PerformanceTotals {
  return typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0 &&
    Number.isSafeInteger(outputTokens) && outputTokens >= 0
    ? { modelDurationMs: durationMs, timedOutputTokens: outputTokens, timedCalls: 1 }
    : { modelDurationMs: 0, timedOutputTokens: 0, timedCalls: 0 };
}

/** Weighted output throughput, including request latency. Missing measurements stay unknown. */
export function outputTokensPerSecond(totals: PerformanceTotals): number | null {
  return totals.timedCalls > 0 && totals.modelDurationMs > 0
    ? totals.timedOutputTokens * 1000 / totals.modelDurationMs : null;
}
