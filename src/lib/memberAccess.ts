/**
 * Where a member's tier composes with the `ADMIN_EMAILS` list — the one
 * derivation of "effective admin".
 *
 * The two list predicates in `runtime-settings.ts` are untouched on purpose:
 * they answer "what does the *list* say" and keep their empty-list semantics
 * (`isAdminEmail` fail-open, `isConfiguredAdmin` fail-closed) as the
 * bootstrap/backstop. Tier `admin` grants what either predicate grants, and a
 * configured admin address is separately promoted and locked by the member
 * use cases. A deployment with no `ADMIN_EMAILS` behaves exactly as it did
 * before tiers.
 *
 * Tier-admin implies *both* predicates: an admin console that could edit
 * settings but not override a project write would be a third predicate nobody
 * asked for.
 */

import type { MemberTier } from "@/domain/member/tiers";
import { memberRepository } from "@/infrastructure/db/repositories/memberRepository";
import { log } from "@/shared/logger";
import { isAdminEmail, isConfiguredAdmin } from "./runtime-settings";

/** What the effective predicates need to know about the caller. */
export interface TieredUser {
  email: string;
  tier: MemberTier;
}

/** May mutate shared registries and app settings — `withAdminAuth`'s question. */
export async function isEffectiveAdmin(user: TieredUser): Promise<boolean> {
  return user.tier === "admin" || isAdminEmail(user.email);
}

/** May write a project owned by someone else — `assertProjectWritable`'s question. */
export async function isEffectiveConfiguredAdmin(user: TieredUser): Promise<boolean> {
  return user.tier === "admin" || isConfiguredAdmin(user.email);
}

/**
 * The email-only form, for the seams that never see a session — today the
 * admin check injected into the project use cases. The list is asked first: it
 * is already cached for 5s, and a configured admin then costs no member read.
 */
export async function isEffectiveConfiguredAdminByEmail(email: string): Promise<boolean> {
  if (await isConfiguredAdmin(email)) {
    return true;
  }
  return (await getMemberTier(email)) === "admin";
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
const tierCacheGenerations = new Map<string, number>();
let tierCacheGeneration = 0;

export function invalidateMemberTierCache(email?: string): void {
  if (email === undefined) {
    tierCacheGeneration += 1;
    tierCacheGenerations.clear();
    tierCache.clear();
  } else {
    const key = email.toLowerCase();
    tierCacheGenerations.set(key, (tierCacheGenerations.get(key) ?? 0) + 1);
    tierCache.delete(key);
  }
}

/**
 * The tier stored for this address, or `null` when no member has it. A storage
 * failure is distinct and fails closed: callers use this result for credential
 * authorization, where "unknown" must not mean "allowed".
 */
export async function getMemberTier(email: string): Promise<MemberTier | null> {
  const key = email.toLowerCase();
  const now = Date.now();
  const cached = tierCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.tier;
  }
  const generation = tierCacheGeneration;
  const keyGeneration = tierCacheGenerations.get(key) ?? 0;
  let tier: MemberTier | null;
  try {
    tier = (await memberRepository.getByEmail(email))?.tier ?? null;
  } catch (error) {
    log.warn("authz", `could not read member tier for ${email}`, error);
    throw new Error("Member tier is temporarily unavailable", {
      cause: error,
    });
  }
  if (generation !== tierCacheGeneration || keyGeneration !== (tierCacheGenerations.get(key) ?? 0)) {
    return tier;
  }
  if (tierCache.size >= TIER_CACHE_MAX_ENTRIES) {
    tierCacheGeneration += 1;
    tierCacheGenerations.clear();
    tierCache.clear();
  }
  tierCache.set(key, { tier, expiresAt: now + TIER_CACHE_TTL_MS });
  return tier;
}
