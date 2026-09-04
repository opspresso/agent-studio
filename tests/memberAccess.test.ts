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
  isEffectiveConfiguredAdmin,
  isEffectiveConfiguredAdminByEmail,
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

const savedAdminEmails = process.env.ADMIN_EMAILS;

const setAdminEmails = (emails: string[]) => {
  if (emails.length === 0) {
    delete process.env.ADMIN_EMAILS;
  } else {
    process.env.ADMIN_EMAILS = emails.join(",");
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  invalidateMemberTierCache();
  setAdminEmails([]);
});

afterEach(() => {
  if (savedAdminEmails === undefined) {
    delete process.env.ADMIN_EMAILS;
  } else {
    process.env.ADMIN_EMAILS = savedAdminEmails;
  }
});

describe("isEffectiveAdmin", () => {
  it("grants a tier admin the list does not contain", async () => {
    setAdminEmails(["someone@x.com"]);
    expect(await isEffectiveAdmin({ email: "u@x.com", tier: "admin" })).toBe(true);
  });

  it("keeps the empty-list fail-open for any tier", async () => {
    expect(await isEffectiveAdmin({ email: "u@x.com", tier: "guest" })).toBe(true);
  });

  it("refuses a non-admin tier not on a configured list", async () => {
    setAdminEmails(["someone@x.com"]);
    expect(await isEffectiveAdmin({ email: "u@x.com", tier: "member" })).toBe(false);
  });
});

describe("isEffectiveConfiguredAdmin", () => {
  it("grants a tier admin on an empty list", async () => {
    expect(await isEffectiveConfiguredAdmin({ email: "u@x.com", tier: "admin" })).toBe(true);
  });

  it("keeps the empty-list fail-closed for other tiers", async () => {
    expect(await isEffectiveConfiguredAdmin({ email: "u@x.com", tier: "guest" })).toBe(false);
  });

  it("still grants a listed email whatever the tier", async () => {
    setAdminEmails(["u@x.com"]);
    expect(await isEffectiveConfiguredAdmin({ email: "u@x.com", tier: "guest" })).toBe(true);
  });
});

describe("isEffectiveConfiguredAdminByEmail", () => {
  it("answers from the list without reading the member row", async () => {
    setAdminEmails(["u@x.com"]);
    expect(await isEffectiveConfiguredAdminByEmail("u@x.com")).toBe(true);
    expect(getByEmail).not.toHaveBeenCalled();
  });

  it("grants an unlisted email whose stored tier is admin", async () => {
    setAdminEmails(["someone@x.com"]);
    getByEmail.mockResolvedValue(member("admin"));
    expect(await isEffectiveConfiguredAdminByEmail("u@x.com")).toBe(true);
  });

  it("refuses an unlisted email whose stored tier is not admin", async () => {
    setAdminEmails(["someone@x.com"]);
    getByEmail.mockResolvedValue(member("member"));
    expect(await isEffectiveConfiguredAdminByEmail("u@x.com")).toBe(false);
  });

  it("fails closed when the member read fails", async () => {
    setAdminEmails(["someone@x.com"]);
    getByEmail.mockRejectedValue(new Error("storage down"));
    await expect(isEffectiveConfiguredAdminByEmail("u@x.com")).rejects.toThrow(
      "Member tier is temporarily unavailable",
    );
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
