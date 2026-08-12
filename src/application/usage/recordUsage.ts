/**
 * Usage recording use case. Turns one LLM call into an atomic per-model
 * increment on the daily usage row. Each call records `calls: 1`; multi-turn
 * agent runs call this once per model call so counts accumulate.
 */

import type { UsageRepository } from "@/domain/usage/repository";
import { log } from "@/shared/logger";
import { utcDay } from "@/shared/date";

export interface RecordUsageInput {
  projectName: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** yyyy-MM-dd; defaults to today (UTC). */
  date?: string;
  /**
   * Who to attribute it to (`kind:id`). Bound at the composition point rather
   * than threaded through the engine: the engine reports what a model call
   * cost, and has no business knowing who asked for it.
   */
  actor?: string;
}

export function todayUtc(): string {
  return utcDay(new Date());
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
    ...(input.actor ? { actor: input.actor } : {}),
  });
}

export interface UsageAggregator {
  /** Buffer one call's usage. Never performs I/O, never rejects. */
  record: (input: RecordUsageInput) => Promise<void>;
  /**
   * Write one atomic increment per (project, date, model). Best-effort.
   *
   * Returns the distinct projects it wrote for. A run spends on more than
   * one whenever it transfers, and the caller is the only thing that can
   * settle a *child* project's thresholds — the run bracket settles the
   * project it admitted and knows nothing about the rest.
   */
  flush: () => Promise<string[]>;
}

/**
 * Collapse a multi-turn run's many usage writes into one increment per
 * (project, date, model). `record` accumulates in memory; `flush` (call it in a
 * `finally` so partial runs still record) performs the writes. Flush is
 * best-effort: a telemetry write failure is logged, never thrown, so it cannot
 * turn into a user-facing error after the answer was already delivered.
 */
export function createUsageAggregator(
  repo: UsageRepository,
  /** Attributed to this caller; one run has exactly one, for all of its turns. */
  actor?: string,
): UsageAggregator {
  const totals = new Map<string, RecordUsageInput & { date: string; calls: number }>();
  return {
    async record(input) {
      const date = input.date ?? todayUtc();
      // `\0` written as an escape, not as the byte. A literal NUL makes the
      // whole file binary to `grep`, `rg` and every tool built on them — and
      // this repository's one defence against a second copy of a decision is
      // searching for the first. The separator itself stays NUL because it is
      // the one character a project name and a model id cannot contain.
      const key = `${input.projectName}\0${date}\0${input.model}`;
      const existing = totals.get(key);
      if (existing) {
        existing.inputTokens += input.inputTokens;
        existing.outputTokens += input.outputTokens;
        existing.costUsd += input.costUsd;
        existing.calls += 1;
      } else {
        totals.set(key, { ...input, date, calls: 1 });
      }
    },
    async flush() {
      const pending = [...totals.values()];
      totals.clear();
      const projects = [...new Set(pending.map((total) => total.projectName))];
      for (const total of pending) {
        try {
          await repo.record({
            projectName: total.projectName,
            date: total.date,
            model: total.model,
            calls: total.calls,
            inputTokens: total.inputTokens,
            outputTokens: total.outputTokens,
            costUsd: total.costUsd,
            // The run's actor, not the buffered record's: a subagent transfer
            // spends on a different project but is still the same person's run.
            ...(actor ? { actor } : {}),
          });
        } catch (error) {
          log.error("usage", "flush failed", { model: total.model, error });
        }
      }
      return projects;
    },
  };
}
