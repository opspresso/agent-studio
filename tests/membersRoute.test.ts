import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError } from "@/application/errors";

const { list, setTier, invalidate, isConfiguredAdmin } = vi.hoisted(() => ({
  list: vi.fn(),
  setTier: vi.fn(),
  invalidate: vi.fn(),
  isConfiguredAdmin: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  withAuth:
    (handler: (...args: any[]) => unknown) =>
    (...args: any[]) =>
      handler({ id: "u1", email: "admin@example.com", name: "A", image: null, tier: "admin" }, ...args),
  withAdminAuth:
    (handler: (...args: any[]) => unknown) =>
    (...args: any[]) =>
      handler({ id: "u1", email: "admin@example.com", name: "A", image: null, tier: "admin" }, ...args),
}));
vi.mock("@/lib/container", () => ({ memberUseCases: { list, setTier } }));
vi.mock("@/lib/memberAccess", () => ({ invalidateMemberTierCache: invalidate }));
vi.mock("@/lib/runtime-settings", () => ({ isConfiguredAdmin }));

const { GET } = await import("@/app/api/members/route");
const { PUT } = await import("@/app/api/members/[id]/tier/route");

const putRequest = (body: unknown) =>
  new Request("http://test/api/members/u2/tier", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const ctx = { params: Promise.resolve({ id: "u2" }) };

beforeEach(() => {
  vi.clearAllMocks();
  isConfiguredAdmin.mockResolvedValue(false);
});

describe("GET /api/members", () => {
  it("returns the member list", async () => {
    const members = [{
      id: "u1",
      name: "Member",
      email: "member@example.com",
      image: null,
      tier: "member",
      joinedAt: "2026-01-01T00:00:00.000Z",
      lastLoginAt: null,
    }];
    list.mockResolvedValue(members);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      members: members.map((member) => ({ ...member, tierLocked: false })),
    });
  });

  it("marks ADMIN_EMAILS members as tier-locked", async () => {
    const member = {
      id: "u1",
      name: "Admin",
      email: "admin@example.com",
      image: null,
      tier: "admin",
      joinedAt: "2026-01-01T00:00:00.000Z",
      lastLoginAt: null,
    };
    list.mockResolvedValue([member]);
    isConfiguredAdmin.mockResolvedValue(true);

    const response = await GET();

    expect(await response.json()).toEqual({ members: [{ ...member, tierLocked: true }] });
  });
});

describe("PUT /api/members/[id]/tier", () => {
  it("updates the tier and invalidates the tier cache", async () => {
    const updated = { id: "u2", email: "m@example.com", tier: "guest" };
    setTier.mockResolvedValue(updated);

    const response = await PUT(putRequest({ tier: "guest" }), ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(updated);
    expect(setTier).toHaveBeenCalledWith({
      id: "u2",
      tier: "guest",
      actorEmail: "admin@example.com",
    });
    expect(invalidate).toHaveBeenCalledWith("m@example.com");
  });

  it("400s an unknown tier without touching the use case", async () => {
    const response = await PUT(putRequest({ tier: "owner" }), ctx);
    expect(response.status).toBe(400);
    expect(setTier).not.toHaveBeenCalled();
  });

  it("400s a body that is not JSON", async () => {
    const response = await PUT(putRequest("not json"), ctx);
    expect(response.status).toBe(400);
  });

  it("404s an unknown member", async () => {
    setTier.mockRejectedValue(new NotFoundError('No member with id "u2"'));
    const response = await PUT(putRequest({ tier: "admin" }), ctx);
    expect(response.status).toBe(404);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
