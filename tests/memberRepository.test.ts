import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMBER_TIER } from "@/domain/member/tiers";

/**
 * Members are Better Auth's `user` rows, read with plain SQL rather than
 * through the item store — so the seam here is the `sql` runner, and what the
 * tests pin is the statement the repository issues and how a row maps back.
 */
const { sql } = vi.hoisted(() => ({ sql: vi.fn() }));

vi.mock("@/infrastructure/db/client", () => ({
  sql,
  getPool: () => {
    throw new Error("unit tests do not open database connections");
  },
  withTransaction: async () => {
    throw new Error("unit tests do not open database connections");
  },
  closePool: async () => {},
}));

const { memberRepository, deleteExpiredSessions } = await import(
  "@/infrastructure/db/repositories/memberRepository"
);

/** The statement text and parameters of the one query a call issued. */
const issued = () => {
  const call = sql.mock.calls[0];
  return { text: String(call?.[0] ?? ""), params: call?.[1] };
};

beforeEach(() => {
  vi.clearAllMocks();
  sql.mockResolvedValue([]);
});

describe("member repository", () => {
  it("maps Better Auth users and ignores malformed rows", async () => {
    // `pg` hands timestamps back as `Date`; a row copied across may still
    // carry the ISO string. Both read as the same instant.
    sql.mockResolvedValue([
      {
        id: "u1",
        name: "Member",
        email: "member@example.com",
        image: "https://example.com/avatar.png",
        tier: "guest",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        lastLoginAt: "2026-02-01T00:00:00.000Z",
      },
      { id: "broken" },
    ]);

    await expect(memberRepository.list(100)).resolves.toEqual([{
      id: "u1",
      name: "Member",
      email: "member@example.com",
      image: "https://example.com/avatar.png",
      tier: "guest",
      joinedAt: "2026-01-01T00:00:00.000Z",
      lastLoginAt: "2026-02-01T00:00:00.000Z",
    }]);
    expect(issued().text).toMatch(/FROM "user"/);
    expect(issued().text).toMatch(/ORDER BY "createdAt", "id" LIMIT \$1/);
    expect(issued().params).toEqual([100]);
  });

  it("reads a row without a tier as the default tier", async () => {
    sql.mockResolvedValue([
      { id: "u1", name: "M", email: "m@example.com", image: null, tier: null, createdAt: "2026-01-01T00:00:00.000Z", lastLoginAt: null },
    ]);
    const [member] = await memberRepository.list(100);
    expect(member?.tier).toBe(DEFAULT_MEMBER_TIER);
    expect(member?.image).toBeNull();
    expect(member?.lastLoginAt).toBeNull();
  });

  it("continues after a createdAt and id cursor", async () => {
    await memberRepository.list(25, {
      joinedAt: "2026-01-01T00:00:00.000Z",
      id: "u1",
    });

    expect(issued().text).toMatch(/WHERE \("createdAt", "id"\) > \(\$2::timestamptz, \$3\)/);
    expect(issued().params).toEqual([25, "2026-01-01T00:00:00.000Z", "u1"]);
  });

  it("finds a member by email with a parameterised lookup", async () => {
    sql.mockResolvedValue([
      { id: "u1", name: "M", email: "m@example.com", image: null, tier: null, createdAt: "2026-01-01T00:00:00.000Z", lastLoginAt: null },
    ]);

    const member = await memberRepository.getByEmail("m@example.com");

    expect(member?.id).toBe("u1");
    expect(issued().text).toMatch(/FROM "user" WHERE "email" = \$1/);
    expect(issued().params).toEqual(["m@example.com"]);
  });

  it("returns null when no member has the email", async () => {
    sql.mockResolvedValue([]);
    await expect(memberRepository.getByEmail("nobody@example.com")).resolves.toBeNull();
  });

  it("finds one member by id without listing the table", async () => {
    sql.mockResolvedValue([
      { id: "u1", name: "M", email: "m@example.com", image: null, tier: null, createdAt: "2026-01-01T00:00:00.000Z", lastLoginAt: null },
    ]);

    await expect(memberRepository.getById("u1")).resolves.toMatchObject({ id: "u1" });
    expect(issued().text).toMatch(/FROM "user" WHERE "id" = \$1/);
    expect(issued().params).toEqual(["u1"]);
  });

  describe("setTier", () => {
    it("writes only the tier column, in one statement, and answers the row it replaced", async () => {
      sql.mockResolvedValue([
        {
          id: "u1",
          name: "M",
          email: "m@example.com",
          image: null,
          tier: "admin",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastLoginAt: null,
          previousTier: "member",
        },
      ]);

      const result = await memberRepository.setTier("u1", "admin");

      expect(result).toEqual({
        member: expect.objectContaining({ id: "u1", tier: "admin" }),
        previousTier: "member",
      });
      // One UPDATE of one column, locking the row it reads the previous tier
      // off: the auth library's own update is a whole-row replace, and a tier
      // routed through it could be reverted by a concurrent `lastLoginAt` write.
      const { text, params } = issued();
      expect(sql).toHaveBeenCalledTimes(1);
      expect(text).toMatch(/UPDATE "user" AS u SET "tier" = \$2/);
      expect(text).not.toMatch(/"name"\s*=|"email"\s*=|"lastLoginAt"\s*=/);
      expect(text).toMatch(/FOR UPDATE/);
      expect(text).toMatch(/RETURNING .*"previousTier"/);
      expect(params).toEqual(["u1", "admin"]);
    });

    it("reports the default as the previous tier for a pre-tier row", async () => {
      sql.mockResolvedValue([
        { id: "u1", name: "M", email: "m@example.com", image: null, tier: "admin", createdAt: "2026-01-01T00:00:00.000Z", lastLoginAt: null, previousTier: null },
      ]);
      const result = await memberRepository.setTier("u1", "admin");
      expect(result?.previousTier).toBe(DEFAULT_MEMBER_TIER);
    });

    it("returns null when the row does not exist", async () => {
      sql.mockResolvedValue([]);
      await expect(memberRepository.setTier("ghost", "admin")).resolves.toBeNull();
    });

    it("rethrows other storage errors", async () => {
      sql.mockRejectedValue(new Error("throttled"));
      await expect(memberRepository.setTier("u1", "admin")).rejects.toThrow("throttled");
    });
  });

  it("sweeps expired sessions by the row's own timestamp, bounded per call", async () => {
    sql.mockResolvedValue([{ id: "s1" }, { id: "s2" }]);
    const now = new Date("2026-08-23T06:00:00.000Z");
    await expect(deleteExpiredSessions(now, 100)).resolves.toBe(2);
    const { text, params } = issued();
    expect(text).toContain('DELETE FROM "session"');
    expect(text).toContain('"expiresAt" <= $1');
    expect(text).toContain("LIMIT $2");
    expect(params).toEqual([now, 100]);
  });
});
