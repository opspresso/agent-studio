import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError } from "@/application/errors";

const { me, memberMonths } = vi.hoisted(() => ({ me: vi.fn(), memberMonths: vi.fn() }));

vi.mock("@/lib/session", () => ({
  withAuth:
    (handler: (...args: any[]) => unknown) =>
    (...args: any[]) =>
      handler({ id: "u1", email: "u@x.com", name: "U", image: null, tier: "guest" }, ...args),
}));
vi.mock("@/lib/container", () => ({
  memberUseCases: { me },
  usageUseCases: { memberMonths },
}));

const { GET } = await import("@/app/api/me/profile/route");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/me/profile", () => {
  it("returns the session user's member row and recent months", async () => {
    const member = { id: "u1", email: "u@x.com", tier: "guest" };
    const months = [{ email: "u@x.com", month: "2026-08", calls: {}, inputTokens: {}, outputTokens: {}, costUsd: {} }];
    me.mockResolvedValue(member);
    memberMonths.mockResolvedValue(months);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ member, months });
    expect(me).toHaveBeenCalledWith("u@x.com");
    expect(memberMonths).toHaveBeenCalledWith("u@x.com", 6);
  });

  it("404s when the member row is gone", async () => {
    me.mockRejectedValue(new NotFoundError("gone"));
    memberMonths.mockResolvedValue([]);
    const response = await GET();
    expect(response.status).toBe(404);
  });
});
