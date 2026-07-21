/** Daily per-project usage aggregates with per-model breakdowns. */
export interface UsageRow {
  projectName: string;
  /** yyyy-MM-dd */
  date: string;
  calls: Record<string, number>;
  inputTokens: Record<string, number>;
  outputTokens: Record<string, number>;
  costUsd: Record<string, number>;
}

export interface UsageDelta {
  projectName: string;
  date: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}
