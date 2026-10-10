import type { UsageRow } from "./types";

/** Every additive usage axis, shared by persistence and cross-row aggregation. */
export const USAGE_COUNTERS = ["calls", "inputTokens", "outputTokens", "cachedTokens", "costUsd",
  "modelDurationMs", "timedOutputTokens", "timedCalls"] as const;
export type UsageCounter = typeof USAGE_COUNTERS[number];
export type UsageCounters = Pick<UsageRow, UsageCounter>;

/** Fresh maps keep stored rows immutable and retain absent performance measurements. */
export function mergeUsageCounters(left: Partial<UsageCounters> | undefined, right: Partial<UsageCounters>): UsageCounters {
  const result: UsageCounters = { calls: {}, inputTokens: {}, outputTokens: {}, costUsd: {} };
  for (const counter of USAGE_COUNTERS) {
    if (!left?.[counter] && !right[counter]) continue;
    const values = { ...left?.[counter] };
    for (const [model, amount] of Object.entries(right[counter] ?? {})) {
      Object.defineProperty(values, model, { value: (Object.hasOwn(values, model) ? values[model]! : 0) + amount,
        enumerable: true, configurable: true, writable: true });
    }
    result[counter] = values;
  }
  return result;
}
