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

// The slice is composed over the mocked repositories rather than stubbed, so
// the real owner gate still runs — which is the whole point of these assertions.
vi.mock("@/lib/container", async () => ({
  traceUseCases: (
    await import("@/application/trace/traceUseCases")
  ).createTraceUseCases({ traces: traceRepo as never, projects: projectRepo as never }),
}));

const { GET } = await import("@/app/api/projects/[name]/traces/route");
const { GET: GET_ONE } = await import("@/app/api/projects/[name]/traces/[traceId]/route");

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

  it("rejects a day the calendar does not have", async () => {
    // Shape-only validation let 2026-02-31 ride into the GSI range condition.
    projectRepo.get.mockResolvedValue({ name: "proj", ownerEmail: "owner@example.com" });
    const res = await GET(
      new Request("http://localhost/api/projects/proj/traces?from=2026-02-31"),
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

describe("GET /api/projects/[name]/traces/[traceId]", () => {
  const oneCtx = (name: string, traceId: string) => ({
    params: Promise.resolve({ name, traceId }),
  });

  it("returns the project's own trace", async () => {
    projectRepo.get.mockResolvedValue({ name: "proj", ownerEmail: "owner@example.com" });
    traceRepo.get.mockResolvedValue({ traceId: "t1", projectName: "proj" });
    const res = await GET_ONE(req(), oneCtx("proj", "t1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ traceId: "t1", projectName: "proj" });
  });

  it("hides a trace stored under a different project", async () => {
    // Which project a trace belongs to is the trace's own record: an owner of
    // one project must not read another's by guessing ids.
    projectRepo.get.mockResolvedValue({ name: "proj", ownerEmail: "owner@example.com" });
    traceRepo.get.mockResolvedValue({ traceId: "t1", projectName: "other" });
    const res = await GET_ONE(req(), oneCtx("proj", "t1"));
    expect(res.status).toBe(404);
  });
});
