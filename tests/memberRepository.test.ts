import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMBER_TIER } from "@/domain/member/tiers";

const { queryAll, send } = vi.hoisted(() => ({ queryAll: vi.fn(), send: vi.fn() }));

vi.mock("@/infrastructure/db/client", () => ({
  getTableName: () => "test-table",
  getDocumentClient: () => ({ send }),
}));
vi.mock("@/infrastructure/db/query", () => ({ queryAll }));

const { memberRepository } = await import("@/infrastructure/db/repositories/memberRepository");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("member repository", () => {
  it("maps Better Auth users and ignores malformed rows", async () => {
    queryAll.mockResolvedValue([
      {
        id: "u1",
        name: "Member",
        email: "member@example.com",
        image: "https://example.com/avatar.png",
        tier: "guest",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastLoginAt: "2026-02-01T00:00:00.000Z",
      },
      { id: "broken" },
    ]);

    await expect(memberRepository.list()).resolves.toEqual([{
      id: "u1",
      name: "Member",
      email: "member@example.com",
      image: "https://example.com/avatar.png",
      tier: "guest",
      joinedAt: "2026-01-01T00:00:00.000Z",
      lastLoginAt: "2026-02-01T00:00:00.000Z",
    }]);
    expect(queryAll).toHaveBeenCalledWith(expect.objectContaining({
      TableName: "test-table",
      IndexName: "GSI1",
      ExpressionAttributeValues: { ":pk": "AUTH#user" },
    }));
  });

  it("reads a row without a tier as the default tier", async () => {
    queryAll.mockResolvedValue([
      { id: "u1", name: "M", email: "m@example.com", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const [member] = await memberRepository.list();
    expect(member?.tier).toBe(DEFAULT_MEMBER_TIER);
  });

  it("finds a member by email through the unique-lookup index", async () => {
    queryAll.mockResolvedValue([
      { id: "u1", name: "M", email: "m@example.com", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);

    const member = await memberRepository.getByEmail("m@example.com");

    expect(member?.id).toBe("u1");
    expect(queryAll).toHaveBeenCalledWith(expect.objectContaining({
      TableName: "test-table",
      IndexName: "GSI2",
      KeyConditionExpression: "GSI2PK = :pk",
      ExpressionAttributeValues: { ":pk": "AUTH#user#email#m@example.com" },
    }));
  });

  it("returns null when no member has the email", async () => {
    queryAll.mockResolvedValue([]);
    await expect(memberRepository.getByEmail("nobody@example.com")).resolves.toBeNull();
  });

  describe("setTier", () => {
    it("writes only the tier attribute, conditionally on the row existing", async () => {
      send.mockResolvedValue({
        Attributes: {
          id: "u1",
          name: "M",
          email: "m@example.com",
          tier: "member",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      });

      const result = await memberRepository.setTier("u1", "admin");

      expect(result).toEqual({
        member: expect.objectContaining({ id: "u1", tier: "admin" }),
        previousTier: "member",
      });
      const input = send.mock.calls[0]?.[0]?.input;
      expect(input).toMatchObject({
        TableName: "test-table",
        Key: { PK: "AUTH#user#u1", SK: "ITEM" },
        ConditionExpression: "attribute_exists(PK)",
        UpdateExpression: "SET tier = :tier",
        ExpressionAttributeValues: { ":tier": "admin" },
        ReturnValues: "ALL_OLD",
      });
    });

    it("reports the default as the previous tier for a pre-tier row", async () => {
      send.mockResolvedValue({
        Attributes: { id: "u1", name: "M", email: "m@example.com", createdAt: "2026-01-01T00:00:00.000Z" },
      });
      const result = await memberRepository.setTier("u1", "admin");
      expect(result?.previousTier).toBe(DEFAULT_MEMBER_TIER);
    });

    it("returns null when the row does not exist", async () => {
      send.mockRejectedValue(Object.assign(new Error("no row"), { name: "ConditionalCheckFailedException" }));
      await expect(memberRepository.setTier("ghost", "admin")).resolves.toBeNull();
    });

    it("rethrows other storage errors", async () => {
      send.mockRejectedValue(Object.assign(new Error("throttled"), { name: "ThrottlingException" }));
      await expect(memberRepository.setTier("u1", "admin")).rejects.toThrow("throttled");
    });
  });
});
