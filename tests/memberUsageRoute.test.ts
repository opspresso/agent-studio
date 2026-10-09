import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSession, members } = vi.hoisted(() => ({ getSession: vi.fn(), members: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/container", () => ({ usageUseCases: { members } }));
const { GET } = await import("@/app/api/usages/members/route");
const request = (range = "from=2026-10-01&to=2026-10-09") => new Request(`http://test/api/usages/members?${range}`);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2026-10-09T00:00:00Z");
  vi.clearAllMocks(); vi.stubEnv("ADMIN_EMAILS", "admin@test.example");
  getSession.mockResolvedValue({ user: { id: "admin", email: "admin@test.example", tier: "admin" } });
  members.mockResolvedValue({ members: [], items: [] });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("GET /api/usages/members", () => {
  it.each([null, "member", "guest"])("refuses %s without reading personal usage", async tier => {
    getSession.mockResolvedValue(tier ? { user: { id: tier, email: `${tier}@test.example`, tier } } : null);
    expect((await GET(request())).status).toBe(tier ? 403 : 401);
    expect(members).not.toHaveBeenCalled();
  });
  it("returns the authorized administrator's requested range", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ members: [], items: [] });
    expect(members).toHaveBeenCalledWith("2026-10-01", "2026-10-09");
  });
  it.each(["", "from=2026-02-31&to=2026-03-01", "from=2026-01-01&to=2026-12-31"])("rejects invalid range %s", async range => {
    expect((await GET(request(range))).status).toBe(400);
    expect(members).not.toHaveBeenCalled();
  });
  it("reports a storage failure as an error", async () => {
    members.mockRejectedValue(new Error("storage unavailable"));
    expect((await GET(request())).status).toBe(500);
  });
});
