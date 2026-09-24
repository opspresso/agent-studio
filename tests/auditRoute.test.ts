import { beforeEach, describe, expect, it, vi } from "vitest";

const { list } = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/lib/container", () => ({ auditUseCases: { list } }));
vi.mock("@/lib/session", () => ({ withAdminAuth: (handler: (user: unknown, request: Request) => Promise<Response>) =>
  (request: Request) => handler({ email: "admin@example.test" }, request) }));

const { GET } = await import("@/app/api/audit/route");

beforeEach(() => {
  list.mockReset();
  list.mockResolvedValue({ events: [], nextCursor: null });
});

describe("GET /api/audit", () => {
  it("forwards the cursor and caps the requested page size", async () => {
    const response = await GET(new Request("https://studio.example.test/api/audit?from=2026-08-01&to=2026-08-03&limit=500&cursor=abc"));
    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledExactlyOnceWith({ from: "2026-08-01", to: "2026-08-03", limit: 50, cursor: "abc" });
    expect(await response.json()).toEqual({ events: [], nextCursor: null });
  });
});
