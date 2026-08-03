/**
 * Which authority the audit trail asks for.
 *
 * Stricter than the rest of the admin surface, and deliberately: these rows say
 * who revealed which credential and when, and who overrode whose project. The
 * ordinary admin gate treats an empty `ADMIN_EMAILS` as "no restriction", which
 * is defensible for editing a shared skill and not for reading that.
 *
 * The predicate itself is exercised against real membership rows in
 * `workspaceAuthz.test.ts`; what this pins is which one the route asks.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { gates, repo } = vi.hoisted(() => ({
  gates: { namedAdmin: false },
  repo: { listByDay: vi.fn() },
}));

const CALLER = { id: "u1", email: "her@example.com", name: "Her", image: null, tenant: "acme" };

vi.mock("@/lib/session", () => ({
  withNamedAdminAuth:
    (handler: (user: unknown, ...args: never[]) => unknown) =>
    (...args: never[]) => {
      if (!gates.namedAdmin) {
        return Response.json({ error: "Only a named admin can access this resource" }, { status: 403 });
      }
      return handler(CALLER, ...args);
    },
}));

vi.mock("@/lib/container", () => ({ auditRepository: repo }));

const { GET } = await import("@/app/api/audit/route");

const read = (query: string) => GET(new Request(`https://studio.example.com/api/audit?${query}`));

beforeEach(() => {
  vi.clearAllMocks();
  gates.namedAdmin = false;
  repo.listByDay.mockResolvedValue([]);
});

describe("reading the trail", () => {
  it("refuses an admin nobody named", async () => {
    expect((await read("from=2026-08-01&to=2026-08-01")).status).toBe(403);
    expect(repo.listByDay).not.toHaveBeenCalled();
  });

  it("serves one, and says whether the range was cut", async () => {
    gates.namedAdmin = true;
    const response = await read("from=2026-08-01&to=2026-08-02");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ events: [], truncated: false });
  });

  it("400s a range it will not read rather than guessing one", async () => {
    gates.namedAdmin = true;
    expect((await read("")).status).toBe(400);
    expect((await read("from=2026-01-01&to=2026-12-31")).status).toBe(400);
  });
});
