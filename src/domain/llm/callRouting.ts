import type { UsageInfo } from "./types";

export const MODEL_TIERS = ["fast", "general", "coding", "reasoning", "vision"] as const;
export type ModelTier = typeof MODEL_TIERS[number];
export const CALL_PURPOSES = ["summary", "classification", "coding", "reasoning", "vision"] as const;
export type CallPurpose = typeof CALL_PURPOSES[number];

/** Models are deployment registrations; these assignments are the Agent's allow list. */
export interface CallRoutingSettings {
  enabled: boolean;
  tiers: Partial<Record<ModelTier, string>>;
  policies: Partial<Record<CallPurpose, ModelTier>>;
  localOnly: boolean;
  maxCallCostUsd: number;
  maxRunCostUsd: number;
  maxCalls: number;
  minOutputChars: number;
}

export const DEFAULT_CALL_ROUTING: CallRoutingSettings = {
  enabled: false, tiers: {}, policies: {}, localOnly: false,
  maxCallCostUsd: 0.1, maxRunCostUsd: 1, maxCalls: 10, minOutputChars: 1,
};

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
  source: "explicit" | "policy" | "jev" | "default" | "promotion";
  outcome: "selected" | "rejected" | "failed" | "quality-rejected" | "completed";
  attempt: number;
  reason?: "permission" | "security" | "capability" | "context" | "budget" | "unavailable" | "decision-failed" | "invalid-decision";
  estimatedCostUsd?: number;
}

/** Checkpoints retain admission counters so approval resumption cannot reset them. */
export interface CallRoutingState {
  calls: number;
  spentUsd: number;
  failures: Record<string, number>;
}

export interface RoutedModelResult {
  text: string;
  usage: UsageInfo;
  truncated?: boolean;
}
