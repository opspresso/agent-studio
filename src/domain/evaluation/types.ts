export const EVALUATION_CRITERIA = ["capabilities", "output", "toolUsage", "prompt"] as const;
export const EVALUATION_STATUSES = ["pass", "needs-improvement", "unknown", "not-applicable"] as const;
export type EvaluationCriterion = typeof EVALUATION_CRITERIA[number];
export type EvaluationStatus = typeof EVALUATION_STATUSES[number];

export interface EvaluationExpectations {
  skills: string[];
  tools: string[];
  outcome: string;
}

export interface EvaluationCheck {
  status: EvaluationStatus;
  summary: string;
  evidence: string[];
  improvements: string[];
}

export interface EvaluationReport {
  summary: string;
  checks: Record<EvaluationCriterion, EvaluationCheck>;
}

/** The console keeps this opaque receipt in memory, never in local storage. */
export interface EvaluationReceipt {
  token: string;
  expiresAt: string;
}

export const MAX_EVALUATION_TOKEN_CHARS = 512_000;
export const MAX_EVALUATION_EXPECTATIONS = 32;
export const MAX_EVALUATION_NAME_CHARS = 128;
export const MAX_EVALUATION_OUTCOME_CHARS = 4_000;
