import { describe, expect, it, vi } from "vitest";

const { queryAll } = vi.hoisted(() => ({ queryAll: vi.fn() }));

vi.mock("@/infrastructure/db/client", () => ({ getTableName: () => "test-table" }));
vi.mock("@/infrastructure/db/query", () => ({ queryAll }));

const { memberRepository } = await import("@/infrastructure/db/repositories/memberRepository");

describe("member repository", () => {
  it("maps Better Auth users and ignores malformed rows", async () => {
    queryAll.mockResolvedValue([
      {
        id: "u1",
        name: "Member",
        email: "member@example.com",
        image: "https://example.com/avatar.png",
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
      joinedAt: "2026-01-01T00:00:00.000Z",
      lastLoginAt: "2026-02-01T00:00:00.000Z",
    }]);
    expect(queryAll).toHaveBeenCalledWith(expect.objectContaining({
      TableName: "test-table",
      IndexName: "GSI1",
      ExpressionAttributeValues: { ":pk": "AUTH#user" },
    }));
  });
});
