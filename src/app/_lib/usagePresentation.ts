import type { MessageKey } from "@/app/_i18n/messages/en";
import type { UsageMetric } from "./usage";
import { formatUsd } from "./formatUsd";

export const USAGE_METRIC_LABELS: Record<UsageMetric, MessageKey> = {
  cost: "usage.cost", calls: "usage.calls", inputTokens: "usage.inputTokens",
  outputTokens: "usage.outputTokens", tokensPerSecond: "usage.tokensPerSecond",
};

export function formatUsageMetric(value: number | null, metric: UsageMetric, locale: string): string {
  if (value === null) return "—";
  return metric === "cost" ? formatUsd(value) : value.toLocaleString(locale, {
    maximumFractionDigits: metric === "tokensPerSecond" ? 2 : 0,
  });
}
