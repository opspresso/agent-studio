/** Member tiers share permissions except for the fixed admin and guest roles. */
export type MemberTier = string;
export const DEFAULT_MEMBER_TIER: MemberTier = "guest";
export const MAX_MEMBER_TIERS = 50;
export const MEMBER_TIER_ID = /^[a-z][a-z0-9_-]{0,39}$/;

export interface MemberTierDefinition {
  id: MemberTier;
  /** USD over a UTC month. Only admin is unlimited (null); zero blocks new runs. */
  monthlyCostCapUsd: number | null;
}

export interface MemberTierSettings {
  revision: number;
  /** Display order only; admin is first and guest is last. */
  tiers: MemberTierDefinition[];
}

/** Installation defaults, used only until an operator saves a tier catalog. */
export const DEFAULT_MEMBER_TIERS: MemberTierDefinition[] = [
  { id: "admin", monthlyCostCapUsd: null },
  { id: "member", monthlyCostCapUsd: 20 },
  { id: "guest", monthlyCostCapUsd: 2 },
];

/** Pin fixed roles while preserving the chosen order of configurable tiers. */
export function orderMemberTiers<T extends { id: MemberTier }>(tiers: readonly T[]): T[] {
  return [
    ...tiers.filter(tier => tier.id === "admin"),
    ...tiers.filter(tier => tier.id !== "admin" && tier.id !== "guest"),
    ...tiers.filter(tier => tier.id === "guest"),
  ];
}

/** Move within the configurable tiers without crossing either fixed role. */
export function moveMemberTier<T extends { id: MemberTier }>(tiers: readonly T[], id: MemberTier, targetId: MemberTier): T[] {
  const ordered = orderMemberTiers(tiers);
  const index = ordered.findIndex(tier => tier.id === id);
  const target = ordered.findIndex(tier => tier.id === targetId);
  if (index <= 0 || index >= ordered.length - 1 || target <= 0 || target >= ordered.length - 1) return ordered;
  const [tier] = ordered.splice(index, 1);
  ordered.splice(target, 0, tier!);
  return ordered;
}

export function isMemberTierDefinitions(value: unknown): value is MemberTierDefinition[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_MEMBER_TIERS) return false;
  const ids = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !MEMBER_TIER_ID.test(entry.id) || ids.has(entry.id)) return false;
    if (Object.keys(entry).some(key => key !== "id" && key !== "monthlyCostCapUsd")) return false;
    ids.add(entry.id);
    if (entry.id === "admin") {
      if (entry.monthlyCostCapUsd !== null) return false;
    } else if (typeof entry.monthlyCostCapUsd !== "number" || !Number.isFinite(entry.monthlyCostCapUsd) || entry.monthlyCostCapUsd < 0) return false;
  }
  return ids.has("admin") && ids.has("guest");
}

export function isMemberTierSettings(value: unknown): value is MemberTierSettings {
  if (!value || typeof value !== "object") return false;
  const candidate = value as MemberTierSettings;
  return Number.isSafeInteger(candidate.revision) && candidate.revision >= 0 && isMemberTierDefinitions(candidate.tiers);
}

/** Preserve custom IDs at storage boundaries; resolve against the catalog before authorization. */
export function storedMemberTier(value: unknown): MemberTier {
  return typeof value === "string" && MEMBER_TIER_ID.test(value) ? value : DEFAULT_MEMBER_TIER;
}

export function toMemberTier(value: unknown, tiers: readonly MemberTierDefinition[] = DEFAULT_MEMBER_TIERS): MemberTier {
  return typeof value === "string" && tiers.some(tier => tier.id === value) ? value : DEFAULT_MEMBER_TIER;
}

export interface TierLimits {
  /** Absent inherits the deployment concurrency limit. */
  maxConcurrentRuns?: number;
  /** Absent is unlimited. */
  monthlyCostCapUsd?: number;
}

/** Shared by execution admission and Profile; unknown tiers inherit guest limits. */
export function memberTierLimits(tier: MemberTier, tiers: readonly MemberTierDefinition[]): TierLimits {
  const effective = toMemberTier(tier, tiers);
  if (effective === "admin") return {};
  const definition = tiers.find(entry => entry.id === effective);
  if (!definition || definition.monthlyCostCapUsd === null) throw new Error("Member tier limits are invalid");
  return { monthlyCostCapUsd: definition.monthlyCostCapUsd, ...(effective === "guest" ? { maxConcurrentRuns: 1 } : {}) };
}

/** Callers pass catalog-resolved tiers; every configurable tier has member permissions. */
export function tierMayEdit(tier: MemberTier): boolean {
  return tier !== "guest";
}
export const tierMayCreateAgents = tierMayEdit;
export const tierMayUseApiTokens = tierMayEdit;
