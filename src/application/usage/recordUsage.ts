/**
 * Usage recording use case. Turns one LLM call into an atomic per-model
 * increment on the daily usage row. Each call records `calls: 1`; multi-turn
 * agent runs call this once per model call so counts accumulate.
 */

import type { UsageRepository } from "@/domain/usage/repository";

export interface RecordUsageInput {
  projectName: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** yyyy-MM-dd; defaults to today (UTC). */
  date?: string;
}

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function recordUsage(
  repo: UsageRepository,
  input: RecordUsageInput,
): Promise<void> {
  await repo.record({
    projectName: input.projectName,
    date: input.date ?? todayUtc(),
    model: input.model,
    calls: 1,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    costUsd: input.costUsd,
  });
}
