import type { DateRange } from "./dateRange";
import type { GroupBy, UsageMetric } from "./usage";
import { USAGE_METRIC_LABELS } from "./usagePresentation";

export interface UsageQuery {
  range: DateRange;
  model: string | null;
  user: string | null;
  groupBy: GroupBy;
  metric: UsageMetric;
}

/** URL owns the displayed query; date validation remains at the existing API boundary. */
export function readUsageQuery(params: Pick<URLSearchParams, "get">, admin: boolean, defaults: DateRange): UsageQuery {
  const user = admin ? params.get("user") || null : null;
  const group = params.get("group");
  const metric = params.get("metric");
  return {
    range: { from: params.get("from") ?? defaults.from, to: params.get("to") ?? defaults.to },
    model: params.get("model") || null,
    user,
    groupBy: group === "model" || group === "provider" || admin && group === "user" ? group : admin && !user ? "user" : "model",
    metric: metric && Object.hasOwn(USAGE_METRIC_LABELS, metric) ? metric as UsageMetric : "cost",
  };
}

/** Preserve unrelated query parameters and pin dates so a shared view cannot drift tomorrow. */
export function writeUsageQuery(value: UsageQuery, current: string): string {
  const params = new URLSearchParams(current);
  params.set("from", value.range.from);
  params.set("to", value.range.to);
  params.set("group", value.groupBy);
  params.set("metric", value.metric);
  for (const key of ["model", "user"] as const) {
    if (value[key]) params.set(key, value[key]);
    else params.delete(key);
  }
  return params.toString();
}
