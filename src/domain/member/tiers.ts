/**
 * The member tier vocabulary, and what each tier may spend.
 *
 * One file owns both on purpose. The union is member-domain vocabulary — it is
 * a field on {@link import("./types").Member} — and the limits are read by two
 * application slices, the concurrency guard in `run` and the member cost guard
 * in `usage`, so placing them beside either mechanism would put an edge between
 * the two slices. Domain is also client-bundle-safe, which is what lets the
 * Members console offer the same tiers the guards enforce.
 *
 * Tier `admin` grants the admin console on top of the `ADMIN_EMAILS` list (the
 * composition lives in `src/lib/memberAccess.ts`). An address in that list is
 * promoted to the stored `admin` tier, so spend and capability limits still
 * have one source: the member's stored tier.
 */

export const MEMBER_TIERS = ["admin", "member", "guest"] as const;

export type MemberTier = (typeof MEMBER_TIERS)[number];

/** What a new sign-up starts as, and what an unrecognized stored value reads as. */
export const DEFAULT_MEMBER_TIER: MemberTier = "guest";

/**
 * Normalize a stored value into a tier. Rows written before tiers existed carry
 * no `tier` attribute at all, and this fallback is what makes that a non-event
 * rather than a migration: every reader passes through here.
 */
export function toMemberTier(value: unknown): MemberTier {
  return typeof value === "string" && (MEMBER_TIERS as readonly string[]).includes(value)
    ? (value as MemberTier)
    : DEFAULT_MEMBER_TIER;
}

export interface TierLimits {
  /** Absent ⇒ the deployment's env limit (`MAX_CONCURRENT_RUNS_PER_ACTOR`) applies. */
  maxConcurrentRuns?: number;
  /** Absent ⇒ uncapped. USD over the UTC month, summed across every project. */
  monthlyCostCapUsd?: number;
  /** May create new projects. Absent ⇒ allowed. */
  canCreateProjects?: boolean;
  /**
   * May a project owned by this tier issue — and authenticate with — API
   * tokens. Absent ⇒ allowed. Owner-scoped, not caller-scoped: the token acts
   * as the owner, so it is the owner's tier that decides whether such a
   * credential may exist at all.
   */
  canUseApiTokens?: boolean;
}

/**
 * What each tier may spend — the single owner of these numbers.
 *
 * `member` deliberately has no `maxConcurrentRuns`: it inherits the
 * deployment's env limit, so raising `MAX_CONCURRENT_RUNS_PER_ACTOR` keeps
 * meaning what it meant before tiers existed. `guest` — what every sign-up
 * starts as — carries its own run ceiling and a small monthly cap, so an
 * account nobody has vetted is bounded before an admin looks at it.
 */
export const TIER_LIMITS: Record<MemberTier, TierLimits> = {
  admin: {},
  member: { monthlyCostCapUsd: 20 },
  guest: {
    maxConcurrentRuns: 1,
    monthlyCostCapUsd: 2,
    canCreateProjects: false,
    canUseApiTokens: false,
  },
};

/**
 * The capability predicates — every gate goes through these rather than
 * comparing tier names, so the answer has one owner on both sides of the
 * wire (the API routes and the buttons the console offers).
 */
export function tierMayCreateProjects(tier: MemberTier): boolean {
  return TIER_LIMITS[tier].canCreateProjects !== false;
}

export function tierMayUseApiTokens(tier: MemberTier): boolean {
  return TIER_LIMITS[tier].canUseApiTokens !== false;
}
