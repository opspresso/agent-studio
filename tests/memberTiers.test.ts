import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEMBER_TIER,
  MEMBER_TIERS,
  TIER_LIMITS,
  tierAtLeast,
  tierMayCreateProjects,
  tierMayUseApiTokens,
  toMemberTier,
} from "@/domain/member/tiers";
import { memberEmailFromActorKey } from "@/domain/execution/actor";

describe("toMemberTier", () => {
  it("returns a recognized tier unchanged", () => {
    for (const tier of MEMBER_TIERS) {
      expect(toMemberTier(tier)).toBe(tier);
    }
  });

  it.each([undefined, null, "", "owner", 3, {}])(
    "falls back to the default for %j",
    (value) => {
      expect(toMemberTier(value)).toBe(DEFAULT_MEMBER_TIER);
    },
  );
});

describe("TIER_LIMITS", () => {
  it("names every tier exactly once", () => {
    expect(Object.keys(TIER_LIMITS).sort()).toEqual([...MEMBER_TIERS].sort());
  });

  it("leaves admin uncapped", () => {
    expect(TIER_LIMITS.admin).toEqual({});
  });
});

describe("memberEmailFromActorKey", () => {
  it("extracts the email from a user actor only", () => {
    expect(memberEmailFromActorKey("user:a@example.com")).toBe("a@example.com");
  });

  it("does not bill a project token to its owner", () => {
    // A token is a service credential bounded by its project's limits; the
    // bypass this would otherwise open is closed by the token-auth tier gate.
    expect(memberEmailFromActorKey("project-token:a@example.com")).toBeNull();
  });

  it("returns null for machine kinds and empty ids", () => {
    expect(memberEmailFromActorKey("slack:U123")).toBeNull();
    expect(memberEmailFromActorKey("a2a:shared-key")).toBeNull();
    expect(memberEmailFromActorKey("webhook:p:t")).toBeNull();
    expect(memberEmailFromActorKey("user:")).toBeNull();
  });
});

describe("tier capabilities", () => {
  it("lets admin and member create projects and use API tokens", () => {
    for (const tier of ["admin", "member"] as const) {
      expect(tierMayCreateProjects(tier)).toBe(true);
      expect(tierMayUseApiTokens(tier)).toBe(true);
    }
  });

  it("refuses both to guest", () => {
    expect(tierMayCreateProjects("guest")).toBe(false);
    expect(tierMayUseApiTokens("guest")).toBe(false);
  });

});

describe("tierAtLeast", () => {
  it("holds every tier to be at least itself", () => {
    for (const tier of MEMBER_TIERS) {
      expect(tierAtLeast(tier, tier)).toBe(true);
    }
  });

  it("orders admin above member above guest", () => {
    expect(tierAtLeast("admin", "member")).toBe(true);
    expect(tierAtLeast("member", "guest")).toBe(true);
    expect(tierAtLeast("member", "admin")).toBe(false);
    expect(tierAtLeast("guest", "member")).toBe(false);
  });

  it("puts a row that predates tiers below member", () => {
    // Worth stating rather than leaving to `toMemberTier`: a member row written
    // before the attribute existed carries no tier, and the `member` rung is
    // the first gate whose default answer removes previously visible access.
    expect(tierAtLeast(toMemberTier(undefined), "member")).toBe(false);
  });
});
