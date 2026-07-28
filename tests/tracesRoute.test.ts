import { beforeEach, describe, expect, it, vi } from "vitest";

// Route-handler test: withAuth is stubbed to inject a controllable user, the
// container repos are mocked, and the real owner-gating use case runs.
const { state, projectRepo, traceRepo } = vi.hoisted(() => ({
  state: { email: "owner@example.com" },
  projectRepo: { get: vi.fn() },
  traceRepo: { listByProject: vi.fn(), get: vi.fn() },
}));

vi.mock("@/lib/session", () => ({
  withAuth:
    (handler: (user: unknown, ...args: any[]) => unknown) =>
    (...args: any[]) =>
      handler({ id: "u1", email: state.email, name: "U", image: null }, ...args),
}));

vi.mock("@/lib/container", () => ({
  projectRepository: projectRepo,
  traceRepository: traceRepo,
}));

const { GET } = await import("@/app/api/projects/[name]/traces/route");

const ctx = (name: string) => ({ params: Promise.resolve({ name }) });
const req = () => new Request("http://localhost/api/projects/proj/traces?limit=10");

beforeEach(() => {
  vi.clearAllMocks();
  state.email = "owner@example.com";
});

describe("GET /api/projects/[name]/traces (owner-gated)", () => {
  it("returns traces to the project owner", async () => {
    projectRepo.get.mockResolvedValue({ name: "proj", ownerEmail: "owner@example.com" });
    traceRepo.listByProject.mockResolvedValue([{ traceId: "t1" }]);
    const res = await GET(req(), ctx("proj"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ traces: [{ traceId: "t1" }] });
    expect(traceRepo.listByProject).toHaveBeenCalledWith("proj", {
      limit: 10,
      from: undefined,
      to: undefined,
    });
  });

  it("passes the from/to date range through to the repository", async () => {
    projectRepo.get.mockResolvedValue({ name: "proj", ownerEmail: "owner@example.com" });
    traceRepo.listByProject.mockResolvedValue([]);
    const res = await GET(
      new Request("http://localhost/api/projects/proj/traces?from=2026-07-01&to=2026-07-31"),
      ctx("proj"),
    );
    expect(res.status).toBe(200);
    expect(traceRepo.listByProject).toHaveBeenCalledWith("proj", {
      limit: 50,
      from: "2026-07-01",
      to: "2026-07-31",
    });
  });

  it("forbids a non-owner with 403 and never reads traces", async () => {
    state.email = "intruder@example.com";
    projectRepo.get.mockResolvedValue({ name: "proj", ownerEmail: "owner@example.com" });
    const res = await GET(req(), ctx("proj"));
    expect(res.status).toBe(403);
    expect(traceRepo.listByProject).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing project", async () => {
    projectRepo.get.mockResolvedValue(undefined);
    const res = await GET(req(), ctx("proj"));
    expect(res.status).toBe(404);
    expect(traceRepo.listByProject).not.toHaveBeenCalled();
  });

  it("rejects a malformed date with 400 and never reads traces", async () => {
    projectRepo.get.mockResolvedValue({ name: "proj", ownerEmail: "owner@example.com" });
    const res = await GET(
      new Request("http://localhost/api/projects/proj/traces?from=2026-7-1"),
      ctx("proj"),
    );
    expect(res.status).toBe(400);
    expect(traceRepo.listByProject).not.toHaveBeenCalled();
  });

  it("rejects a reversed range (from > to) with 400", async () => {
    projectRepo.get.mockResolvedValue({ name: "proj", ownerEmail: "owner@example.com" });
    const res = await GET(
      new Request("http://localhost/api/projects/proj/traces?from=2026-07-31&to=2026-07-01"),
      ctx("proj"),
    );
    expect(res.status).toBe(400);
    expect(traceRepo.listByProject).not.toHaveBeenCalled();
  });
});
