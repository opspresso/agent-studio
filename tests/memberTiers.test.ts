import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEMBER_TIER,
  DEFAULT_MEMBER_TIERS,
  memberTierLimits,
  moveMemberTier,
  orderMemberTiers,
  tierMayEdit,
  isMemberTierDefinitions,
  storedMemberTier,
  tierMayCreateAgents,
  tierMayUseApiTokens,
  toMemberTier,
} from "@/domain/member/tiers";
import { memberEmailFromActorKey } from "@/domain/execution/actor";

describe("toMemberTier", () => {
  it("returns a recognized tier unchanged", () => {
    for (const { id: tier } of DEFAULT_MEMBER_TIERS) {
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

describe("member tier order", () => {
  const tiers = [
    { id: "admin", monthlyCostCapUsd: null },
    { id: "premium", monthlyCostCapUsd: 75 },
    { id: "member", monthlyCostCapUsd: 20 },
    { id: "guest", monthlyCostCapUsd: 2 },
  ];
  it("pins admin and guest while preserving custom order and input data", () => {
    const input = [tiers[2]!, tiers[3]!, tiers[1]!, tiers[0]!];
    const before = [...input];
    expect(orderMemberTiers(input)).toEqual([tiers[0], tiers[2], tiers[1], tiers[3]]);
    expect(input).toEqual(before);
  });
  it("moves a configurable tier in either direction without changing its limits", () => {
    const moved = moveMemberTier(tiers, "member", "premium");
    expect(moved).toEqual([tiers[0], tiers[2], tiers[1], tiers[3]]);
    expect(moveMemberTier(moved, "member", "premium")).toEqual(tiers);
    expect(tiers.map(tier => tier.id)).toEqual(["admin", "premium", "member", "guest"]);
  });
  it.each([
    ["admin", "member"], ["guest", "premium"], ["premium", "admin"], ["member", "guest"], ["missing", "member"], ["member", "missing"],
  ] as const)("does not move %s beyond its allowed position", (id, targetId) => {
    expect(moveMemberTier(tiers, id, targetId)).toEqual(tiers);
  });
});

describe("member tier catalog", () => {
  const tiers = [...DEFAULT_MEMBER_TIERS, { id: "premium", monthlyCostCapUsd: 75 }];
  it("resolves custom tiers and their configured caps, retaining member permissions", () => {
    expect(storedMemberTier("premium")).toBe("premium");
    expect(toMemberTier("premium", tiers)).toBe("premium");
    expect(memberTierLimits("premium", tiers)).toEqual({ monthlyCostCapUsd: 75 });
    expect(tierMayEdit("premium")).toBe(true);
    expect(tierMayUseApiTokens("premium")).toBe(true);
    expect(tierMayCreateAgents("premium")).toBe(true);
    expect(memberTierLimits("admin", tiers)).toEqual({});
    expect(toMemberTier("deleted", tiers)).toBe("guest");
    expect(memberTierLimits("deleted", tiers)).toEqual(memberTierLimits("guest", tiers));
  });
  it("allows removing member but requires fixed admin and guest and finite non-admin caps", () => {
    expect(isMemberTierDefinitions(tiers.filter(tier => tier.id !== "member"))).toBe(true);
    for (const id of ["admin", "guest"]) expect(isMemberTierDefinitions(tiers.filter(tier => tier.id !== id))).toBe(false);
    expect(isMemberTierDefinitions([...tiers, tiers[1]])).toBe(false);
    for (const cap of [-1, null, NaN, Infinity]) {
      expect(isMemberTierDefinitions(tiers.map(tier => tier.id === "guest" ? { ...tier, monthlyCostCapUsd: cap } : tier))).toBe(false);
    }
    expect(isMemberTierDefinitions(tiers.map(tier => tier.id === "admin" ? { ...tier, monthlyCostCapUsd: 20 } : tier))).toBe(false);
  });
});

describe("memberEmailFromActorKey", () => {
  it("extracts the email from a user actor only", () => {
    expect(memberEmailFromActorKey("user:a@example.com")).toBe("a@example.com");
  });

  it("does not bill an agent token to its owner", () => {
    // A token is a service credential bounded by its agent's limits; the
    // bypass this would otherwise open is closed by the token-auth tier gate.
    expect(memberEmailFromActorKey("agent-token:a@example.com")).toBeNull();
  });

  it("returns null for machine kinds and empty ids", () => {
    expect(memberEmailFromActorKey("slack:U123")).toBeNull();
    expect(memberEmailFromActorKey("webhook:p:t")).toBeNull();
    expect(memberEmailFromActorKey("user:")).toBeNull();
  });
});

describe("tier capabilities", () => {
  it("lets admin and member create agents and use API tokens", () => {
    for (const tier of ["admin", "member"] as const) {
      expect(tierMayCreateAgents(tier)).toBe(true);
      expect(tierMayUseApiTokens(tier)).toBe(true);
    }
  });

  it("refuses both to guest", () => {
    expect(tierMayCreateAgents("guest")).toBe(false);
    expect(tierMayUseApiTokens("guest")).toBe(false);
  });

});

describe("tier editing", () => {
  it("treats every configurable tier as a member and keeps guests read-only", () => {
    expect(tierMayEdit("admin")).toBe(true);
    expect(tierMayEdit("member")).toBe(true);
    expect(tierMayEdit("premium")).toBe(true);
    expect(tierMayEdit("guest")).toBe(false);
    expect(tierMayEdit(toMemberTier(undefined))).toBe(false);
  });
});
