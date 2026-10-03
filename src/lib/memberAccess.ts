/**
 * Compose stored tiers with operator admin lists. The empty-list bootstrap
 * permits members to administer shared resources; guests remain read-only.
 * Explicitly configured admins are promoted to tier admin at session resolution.
 */

import { tierMayEdit, toMemberTier, type MemberTier } from "@/domain/member/tiers";
import { memberRepository } from "@/infrastructure/db/repositories/memberRepository";
import type { Member } from "@/domain/member/types";
import { log } from "@/shared/logger";
import { getMemberTierDefinitions, isAdminEmail, isConfiguredAdmin } from "./runtime-settings";

/** What the effective predicates need to know about the caller. */
export interface TieredUser {
  email: string;
  tier: MemberTier;
}

/** May mutate shared registries and app settings — `withAdminAuth`'s question. */
export async function isEffectiveAdmin(user: TieredUser): Promise<boolean> {
  return user.tier === "admin" || (tierMayEdit(user.tier) && await isAdminEmail(user.email));
}

/**
 * The tier cache exists for the paths that resolve a tier *per run* rather
 * than per session read — the run-bracket guards. 30 seconds, per instance,
 * the same posture as the settings cache: a tier change reaches every
 * instance within the TTL, and the instance that served the write is told
 * immediately via {@link invalidateMemberTierCache}.
 */
const TIER_CACHE_TTL_MS = 30_000;
/** Every signed-in human on the deployment fits; past it, start over. */
const TIER_CACHE_MAX_ENTRIES = 1000;

const tierCache = new Map<string, { tier: MemberTier | null; expiresAt: number }>();
/** One epoch fences pending reads without retaining an invalidation record per email. */
let tierCacheGeneration = 0;

export function invalidateMemberTierCache(email?: string): void {
  tierCacheGeneration += 1;
  if (email === undefined) {
    tierCache.clear();
  } else {
    tierCache.delete(email.toLowerCase());
  }
}

/**
 * The tier stored for this address, or `null` when no member has it. A storage
 * failure is distinct and fails closed: callers use this result for credential
 * authorization, where "unknown" must not mean "allowed".
 */
export async function getMemberTier(email: string): Promise<MemberTier | null> {
  const resolved = async (tier: MemberTier | null) => tier === null ? null : toMemberTier(tier, await getMemberTierDefinitions());
  const key = email.toLowerCase();
  const now = Date.now();
  const cached = tierCache.get(key);
  if (cached && cached.expiresAt > now) {
    return resolved(cached.tier);
  }
  const generation = tierCacheGeneration;
  let tier: MemberTier | null;
  try {
    tier = (await memberRepository.getByEmail(email))?.tier ?? null;
  } catch (error) {
    log.warn("authz", `could not read member tier for ${email}`, error);
    throw new Error("Member tier is temporarily unavailable", {
      cause: error,
    });
  }
  if (generation !== tierCacheGeneration) {
    return resolved(tier);
  }
  if (tierCache.size >= TIER_CACHE_MAX_ENTRIES) {
    tierCacheGeneration += 1;
    tierCache.clear();
  }
  tierCache.set(key, { tier, expiresAt: now + TIER_CACHE_TTL_MS });
  return resolved(tier);
}

/** Resolve a credential's stable user ID from the current account row, without the email tier cache. */
export async function getExecutionMemberById(id: string): Promise<Member | null> {
  const member = await memberRepository.getById(id);
  if (!member) return null;
  return { ...member, tier: await isConfiguredAdmin(member.email) ? "admin" : toMemberTier(member.tier, await getMemberTierDefinitions()) };
}
