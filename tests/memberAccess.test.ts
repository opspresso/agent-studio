import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same posture as tests/session.test.ts: the admin list is steered through
// `ADMIN_EMAILS` so the real empty-list semantics stay under test, and the
// member repository is the mocked boundary.
const { getByEmail } = vi.hoisted(() => ({ getByEmail: vi.fn() }));

vi.mock("@/infrastructure/db/repositories/memberRepository", () => ({
  memberRepository: { getByEmail, list: vi.fn(), setTier: vi.fn() },
}));

const {
  getMemberTier,
  invalidateMemberTierCache,
  isEffectiveAdmin,
} = await import("@/lib/memberAccess");

const member = (tier: string) => ({
  id: "u1",
  name: "U",
  email: "u@x.com",
  image: null,
  tier,
  joinedAt: "2026-01-01T00:00:00.000Z",
  lastLoginAt: null,
});

const setAdminEmails = (emails: string[]) => {
  vi.stubEnv("ADMIN_EMAILS", emails.length === 0 ? undefined : emails.join(","));
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-01-01T00:00:00.000Z");
  invalidateMemberTierCache();
  setAdminEmails([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  invalidateMemberTierCache();
});

describe("isEffectiveAdmin", () => {
  it("grants a tier admin the list does not contain", async () => {
    setAdminEmails(["someone@x.com"]);
    expect(await isEffectiveAdmin({ email: "u@x.com", tier: "admin" })).toBe(true);
  });

  it("keeps bootstrap administration for members while refusing guests", async () => {
    expect(await isEffectiveAdmin({ email: "u@x.com", tier: "guest" })).toBe(false);
    expect(await isEffectiveAdmin({ email: "u@x.com", tier: "member" })).toBe(true);
  });

  it("refuses a non-admin tier not on a configured list", async () => {
    setAdminEmails(["someone@x.com"]);
    expect(await isEffectiveAdmin({ email: "u@x.com", tier: "member" })).toBe(false);
  });
});

describe("getMemberTier", () => {
  it("caches a lookup until invalidated", async () => {
    getByEmail.mockResolvedValue(member("guest"));
    expect(await getMemberTier("u@x.com")).toBe("guest");
    expect(await getMemberTier("u@x.com")).toBe("guest");
    expect(getByEmail).toHaveBeenCalledTimes(1);

    invalidateMemberTierCache("u@x.com");
    getByEmail.mockResolvedValue(member("admin"));
    expect(await getMemberTier("u@x.com")).toBe("admin");
    expect(getByEmail).toHaveBeenCalledTimes(2);
  });

  it("does not let an earlier lookup repopulate the cache after invalidation", async () => {
    let resolveFirst!: (value: ReturnType<typeof member>) => void;
    getByEmail
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValue(member("admin"));

    const staleRead = getMemberTier("u@x.com");
    invalidateMemberTierCache("u@x.com");
    resolveFirst(member("guest"));
    expect(await staleRead).toBe("guest");
    expect(await getMemberTier("u@x.com")).toBe("admin");
    expect(getByEmail).toHaveBeenCalledTimes(2);
  });

  it("keeps unrelated cached users through repeated targeted invalidation", async () => {
    getByEmail.mockResolvedValue(member("member"));
    expect(await getMemberTier("u@x.com")).toBe("member");
    for (let index = 0; index < 2_000; index++) invalidateMemberTierCache(`other-${index}@example.test`);
    expect(await getMemberTier("u@x.com")).toBe("member");
    expect(getByEmail).toHaveBeenCalledTimes(1);
  });

  it("caches the absence of a member too", async () => {
    getByEmail.mockResolvedValue(null);
    expect(await getMemberTier("machine@x.com")).toBeNull();
    expect(await getMemberTier("machine@x.com")).toBeNull();
    expect(getByEmail).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed read", async () => {
    getByEmail.mockRejectedValueOnce(new Error("storage down"));
    await expect(getMemberTier("u@x.com")).rejects.toThrow(
      "Member tier is temporarily unavailable",
    );
    getByEmail.mockResolvedValue(member("admin"));
    expect(await getMemberTier("u@x.com")).toBe("admin");
  });
});
