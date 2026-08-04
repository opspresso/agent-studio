import { beforeEach, describe, expect, it, vi } from "vitest";

const { list } = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@/lib/session", () => ({
  withAdminAuth:
    (handler: (...args: any[]) => unknown) =>
    (...args: any[]) =>
      handler({ id: "u1", email: "admin@example.com", name: "A", image: null }, ...args),
}));
vi.mock("@/lib/container", () => ({ memberUseCases: { list } }));

const { GET } = await import("@/app/api/members/route");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/members", () => {
  it("returns the member list", async () => {
    const members = [{
      id: "u1",
      name: "Member",
      email: "member@example.com",
      image: null,
      joinedAt: "2026-01-01T00:00:00.000Z",
      lastLoginAt: null,
    }];
    list.mockResolvedValue(members);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ members });
  });
});
