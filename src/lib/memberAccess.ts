/**
 * Where a member's tier composes with the `ADMIN_EMAILS` list — the one
 * derivation of "effective admin".
 *
 * The two list predicates in `runtime-settings.ts` are untouched on purpose:
 * they answer "what does the *list* say" and keep their empty-list semantics
 * (`isAdminEmail` fail-open, `isConfiguredAdmin` fail-closed) as the
 * bootstrap/backstop. A tier is strictly additive — tier `admin` grants what
 * either predicate grants, and no tier ever takes away what the list gave, so a
 * deployment with no `ADMIN_EMAILS` behaves exactly as it did before tiers.
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

export function invalidateMemberTierCache(email?: string): void {
  if (email === undefined) {
    tierCache.clear();
  } else {
    tierCache.delete(email.toLowerCase());
  }
}

/**
 * The tier stored for this address, or `null` when no member has it — a
 * machine identity, or a row the read could not reach. Fail-soft: an error
 * resolves `null` and the caller falls back to list-only semantics, matching
 * how every other guard treats its own read failing.
 */
export async function getMemberTier(email: string): Promise<MemberTier | null> {
  const key = email.toLowerCase();
  const now = Date.now();
  const cached = tierCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.tier;
  }
  let tier: MemberTier | null;
  try {
    tier = (await memberRepository.getByEmail(email))?.tier ?? null;
  } catch (error) {
    log.warn("authz", `could not read member tier for ${email}; using the admin list alone`, error);
    return null;
  }
  if (tierCache.size >= TIER_CACHE_MAX_ENTRIES) {
    tierCache.clear();
  }
  tierCache.set(key, { tier, expiresAt: now + TIER_CACHE_TTL_MS });
  return tier;
}
