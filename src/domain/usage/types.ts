/** Daily per-agent usage aggregates with per-model breakdowns. */
export interface UsageRow {
  agentName: string;
  /** yyyy-MM-dd */
  date: string;
  calls: Record<string, number>;
  inputTokens: Record<string, number>;
  outputTokens: Record<string, number>;
  /**
   * Of `inputTokens`, how many the provider served from its cache, per model.
   *
   * Optional because a row written before the field existed does not carry it,
   * and because only a provider that reports `prompt_tokens_details` can fill
   * it — the repository always writes the map, so absent means "nothing here
   * ever reported one", not "unknown".
   */
  cachedTokens?: Record<string, number>;
  costUsd: Record<string, number>;
  /** Matched performance samples only; absent on unmeasured history. */
  modelDurationMs?: Record<string, number>;
  timedOutputTokens?: Record<string, number>;
  timedCalls?: Record<string, number>;
}

/**
 * One caller's spend on one agent for one day.
 *
 * A separate row rather than another dimension on {@link UsageRow}: that row
 * holds a map per metric keyed by model, and keying those by `actor|model`
 * instead would grow one row with the number of distinct callers — a busy
 * agent's daily row would be rewritten whole for every caller's every call,
 * and the dashboard would pay for every caller on every read whether it wanted
 * them or not. Splitting keeps both reads exactly as wide as their question.
 */
export interface ActorUsageRow extends MemberUsageRow {
  /** `kind:id` — see `actorKey` in `domain/execution/actor.ts`. */
  actor: string;
}

/** One Studio account cross-source spend on one Agent for one UTC day. */
export interface MemberUsageRow extends UsageRow {
  userId: string;
}

export interface UsageDelta {
  /** Stable event identity for durable callers replaying the same receipt. */
  idempotencyKey?: string;
  agentName: string;
  date: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Of `inputTokens`, how many the provider served from its cache. */
  cachedTokens?: number;
  costUsd: number;
  modelDurationMs?: number;
  timedOutputTokens?: number;
  timedCalls?: number;
  /** Captured Studio account, independent of the invocation source. */
  userId: string;
  /** Original invocation source as kind:id, retained for audit. */
  actor: string;
}
