import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError } from "@/application/errors";

const { me, memberUsage, memberMonthToDate } = vi.hoisted(() => ({
  me: vi.fn(),
  memberUsage: vi.fn(),
  memberMonthToDate: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  withAuth:
    (handler: (...args: any[]) => unknown) =>
    (...args: any[]) =>
      handler({ id: "u1", email: "u@x.com", name: "U", image: null, tier: "guest" }, ...args),
}));
vi.mock("@/lib/container", () => ({
  memberUseCases: { me },
  usageUseCases: { memberUsage, memberMonthToDate },
}));

const { GET: profile } = await import("@/app/api/me/profile/route");
const { GET: usage } = await import("@/app/api/me/usage/route");

const usageRequest = (query: string) => new Request(`http://test/api/me/usage${query}`);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/me/profile", () => {
  it("returns the session user's row and their month-to-date spend", async () => {
    const member = { id: "u1", email: "u@x.com", tier: "guest" };
    me.mockResolvedValue(member);
    memberMonthToDate.mockResolvedValue(1.25);

    const response = await profile();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ member, monthToDateUsd: 1.25 });
    expect(me).toHaveBeenCalledWith("u@x.com");
    expect(memberMonthToDate).toHaveBeenCalledWith("u@x.com");
  });

  it("404s when the member row is gone", async () => {
    me.mockRejectedValue(new NotFoundError("gone"));
    memberMonthToDate.mockResolvedValue(0);
    expect((await profile()).status).toBe(404);
  });
});

describe("GET /api/me/usage", () => {
  it("returns the caller's own rows for the range", async () => {
    const items = [{ email: "u@x.com", date: "2026-08-13", calls: {}, inputTokens: {}, outputTokens: {}, costUsd: {} }];
    memberUsage.mockResolvedValue(items);

    const response = await usage(usageRequest("?from=2026-08-01&to=2026-08-13"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items });
    // Never an email from the query: the session user is the only subject.
    expect(memberUsage).toHaveBeenCalledWith("u@x.com", "2026-08-01", "2026-08-13");
  });

  it("400s a range the summary schema refuses, without reading anything", async () => {
    expect((await usage(usageRequest("?from=2026-08-13&to=2026-08-01"))).status).toBe(400);
    expect((await usage(usageRequest("?from=2026-02-31&to=2026-03-05"))).status).toBe(400);
    expect((await usage(usageRequest(""))).status).toBe(400);
    expect(memberUsage).not.toHaveBeenCalled();
  });
});
