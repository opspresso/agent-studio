export const MODEL_TIERS = ["fast", "general", "coding", "reasoning", "vision"] as const;
export type ModelTier = typeof MODEL_TIERS[number];
export const CALL_PURPOSES = ["summary", "classification", "coding", "reasoning", "vision"] as const;
export type CallPurpose = typeof CALL_PURPOSES[number];
export const CALL_ROUTING_LIMITS = { maxCalls: 30, maxBudgetUsd: 100, maxMinOutputChars: 1_000 } as const;
export const MODEL_ROUTING_POLICY_BINDING = "model-routing";

/** Deployment-owned model pool and constraints, shared by opted-in Agents. */
export interface CallRoutingPolicy {
  tiers: Partial<Record<ModelTier, string>>;
  policies: Partial<Record<CallPurpose, ModelTier>>;
  localOnly: boolean;
  maxCallCostUsd: number;
  maxRunCostUsd: number;
  maxCalls: number;
  minOutputChars: number;
}

/** A runtime snapshot combines the shared policy with one Agent's opt-in. */
export interface CallRoutingSettings extends CallRoutingPolicy { enabled: boolean }

export const DEFAULT_CALL_ROUTING_POLICY: CallRoutingPolicy = {
  tiers: {}, policies: {}, localOnly: false,
  maxCallCostUsd: 0.1, maxRunCostUsd: 1, maxCalls: 10, minOutputChars: 1,
};
export const DEFAULT_CALL_ROUTING: CallRoutingSettings = { ...DEFAULT_CALL_ROUTING_POLICY, enabled: false };

/** Validate persisted policy without a framework dependency or silently dropping fields. */
export function isCallRoutingPolicy(value: unknown): value is CallRoutingPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  if (Object.keys(policy).some(key => !["tiers", "policies", "localOnly", "maxCallCostUsd", "maxRunCostUsd", "maxCalls", "minOutputChars"].includes(key))) return false;
  const map = (entry: unknown): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry));
  if (!map(policy.tiers) || Object.entries(policy.tiers).some(([tier, id]) => !MODEL_TIERS.includes(tier as ModelTier) || typeof id !== "string" || !id.trim() || id.length > 200)) return false;
  if (!map(policy.policies) || Object.entries(policy.policies).some(([purpose, tier]) => !CALL_PURPOSES.includes(purpose as CallPurpose) || !MODEL_TIERS.includes(tier as ModelTier))) return false;
  const budget = (amount: unknown): amount is number => typeof amount === "number" && Number.isFinite(amount) && amount > 0 && amount <= CALL_ROUTING_LIMITS.maxBudgetUsd;
  return typeof policy.localOnly === "boolean" && budget(policy.maxCallCostUsd) && budget(policy.maxRunCostUsd) && policy.maxCallCostUsd <= policy.maxRunCostUsd &&
    typeof policy.maxCalls === "number" && Number.isInteger(policy.maxCalls) && policy.maxCalls >= 1 && policy.maxCalls <= CALL_ROUTING_LIMITS.maxCalls &&
    typeof policy.minOutputChars === "number" && Number.isInteger(policy.minOutputChars) && policy.minOutputChars >= 1 && policy.minOutputChars <= CALL_ROUTING_LIMITS.maxMinOutputChars;
}

export interface RoutedModelTask {
  purpose: CallPurpose;
  prompt: string;
  /** Explicit overrides may address only the base model or an assigned tier model. */
  model?: string;
  imageCount: number;
  maxOutputTokens: number;
}

export interface CallRoutingEvent {
  purpose: CallPurpose;
  model?: string;
  tier?: ModelTier;
  source: "explicit" | "policy" | "sole-candidate" | "jev" | "default" | "promotion";
  outcome: "selected" | "rejected" | "failed" | "quality-rejected" | "completed";
  attempt: number;
  reason?: "permission" | "security" | "capability" | "context" | "budget" | "unavailable" | "decision-failed" | "invalid-decision" | "ambiguous-decision";
  estimatedCostUsd?: number;
  decisionConfidence?: number;
  decisionProbabilities?: Partial<Record<ModelTier, number>>;
}

/** Checkpoints retain admission counters so approval resumption cannot reset them. */
export interface CallRoutingState {
  calls: number;
  spentUsd: number;
  failures: Record<string, number>;
}
