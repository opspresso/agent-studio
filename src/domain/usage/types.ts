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

/**
 * One caller's spend on one project for one day.
 *
 * A separate row rather than another dimension on {@link UsageRow}: that row
 * holds a map per metric keyed by model, and keying those by `actor|model`
 * instead would grow one item with the number of distinct callers — a busy
 * project would approach DynamoDB's 400KB item limit within a day, and the
 * dashboard would pay for every caller on every read whether it wanted them or
 * not. Splitting keeps both reads exactly as wide as their question.
 */
export interface ActorUsageRow {
  projectName: string;
  /** yyyy-MM-dd */
  date: string;
  /** `kind:id` — see `actorKey` in `domain/execution/actor.ts`. */
  actor: string;
  calls: Record<string, number>;
  inputTokens: Record<string, number>;
  outputTokens: Record<string, number>;
  costUsd: Record<string, number>;
}

/**
 * One member's own spend for one UTC month, summed across every project.
 * Only `user` actors land here — a project token spends against its project,
 * not its owner; see `memberEmailFromActorKey` in `domain/execution/actor.ts`.
 */
export interface MemberMonthlyUsageRow {
  email: string;
  /** yyyy-MM */
  month: string;
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
  /**
   * Who to bill it to, as `kind:id`. Absent means the run had no identifiable
   * caller, and only the project total is written — attribution is additive, so
   * a path that cannot name its actor still records the spend it caused.
   */
  actor?: string;
}
