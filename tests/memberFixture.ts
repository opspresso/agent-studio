import type { Member } from "@/domain/member/types";

/** Deterministic member rows for repository-boundary tests. */
export function memberFixture(overrides: Partial<Member> = {}): Member {
  return { id: "member-id", email: "member@example.test", name: "Member", tier: "member", image: null,
    joinedAt: "2026-01-01T00:00:00Z", lastLoginAt: "2026-01-01T00:00:00Z", ...overrides };
}
