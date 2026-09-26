import { beforeEach, describe, expect, it, vi } from "vitest";

// Route-handler test: withAuth is stubbed to inject a controllable user, the
// container repos are mocked, and the real owner-gating use case runs.
const { state, agentRepo, traceRepo } = vi.hoisted(() => ({
  state: { email: "owner@example.com" },
  agentRepo: { get: vi.fn() },
  traceRepo: { listByAgent: vi.fn(), get: vi.fn() },
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
  ).createTraceUseCases({ traces: traceRepo as never, agents: agentRepo as never }),
}));

const { GET } = await import("@/app/api/agents/[name]/traces/route");
const { GET: GET_ONE } = await import("@/app/api/agents/[name]/traces/[traceId]/route");

const ctx = (name: string) => ({ params: Promise.resolve({ name }) });
const req = () => new Request("http://localhost/api/agents/proj/traces?limit=10");

beforeEach(() => {
  vi.clearAllMocks();
  state.email = "owner@example.com";
});

describe("GET /api/agents/[name]/traces (owner-gated)", () => {
  it("returns traces to the agent owner", async () => {
    agentRepo.get.mockResolvedValue({ name: "proj", ownerEmail: "owner@example.com" });
    traceRepo.listByAgent.mockResolvedValue([{ traceId: "t1" }]);
    const res = await GET(req(), ctx("proj"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ traces: [{ traceId: "t1" }] });
    expect(traceRepo.listByAgent).toHaveBeenCalledWith("proj", {
      limit: 10,
      from: undefined,
      to: undefined,
      actorKind: undefined,
    });
  });

  it("passes the from/to date range through to the repository", async () => {
    agentRepo.get.mockResolvedValue({ name: "proj", ownerEmail: "owner@example.com" });
    traceRepo.listByAgent.mockResolvedValue([]);
    const res = await GET(
      new Request("http://localhost/api/agents/proj/traces?from=2026-07-01&to=2026-07-31"),
      ctx("proj"),
    );
    expect(res.status).toBe(200);
    expect(traceRepo.listByAgent).toHaveBeenCalledWith("proj", {
      limit: 50,
      from: "2026-07-01",
      to: "2026-07-31",
      actorKind: undefined,
    });
  });

  it("passes a validated actor kind to the repository", async () => {
    agentRepo.get.mockResolvedValue({ name: "proj", ownerEmail: "owner@example.com" });
    traceRepo.listByAgent.mockResolvedValue([]);
    const res = await GET(new Request("http://localhost/api/agents/proj/traces?actorKind=slack"), ctx("proj"));
    expect(res.status).toBe(200);
    expect(traceRepo.listByAgent).toHaveBeenCalledWith("proj", {
      limit: 50, from: undefined, to: undefined, actorKind: "slack",
    });
  });

  it("rejects an unknown actor kind before reading traces", async () => {
    const res = await GET(new Request("http://localhost/api/agents/proj/traces?actorKind=other"), ctx("proj"));
    expect(res.status).toBe(400);
    expect(traceRepo.listByAgent).not.toHaveBeenCalled();
  });

  it("forbids a non-owner with 403 and never reads traces", async () => {
    state.email = "intruder@example.com";
    agentRepo.get.mockResolvedValue({ name: "proj", ownerEmail: "owner@example.com" });
    const res = await GET(req(), ctx("proj"));
    expect(res.status).toBe(403);
    expect(traceRepo.listByAgent).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing agent", async () => {
    agentRepo.get.mockResolvedValue(undefined);
    const res = await GET(req(), ctx("proj"));
    expect(res.status).toBe(404);
    expect(traceRepo.listByAgent).not.toHaveBeenCalled();
  });

  it("rejects a malformed date with 400 and never reads traces", async () => {
    agentRepo.get.mockResolvedValue({ name: "proj", ownerEmail: "owner@example.com" });
    const res = await GET(
      new Request("http://localhost/api/agents/proj/traces?from=2026-7-1"),
      ctx("proj"),
    );
    expect(res.status).toBe(400);
    expect(traceRepo.listByAgent).not.toHaveBeenCalled();
  });

  it("rejects a day the calendar does not have", async () => {
    // Shape-only validation let 2026-02-31 ride into the GSI range condition.
    agentRepo.get.mockResolvedValue({ name: "proj", ownerEmail: "owner@example.com" });
    const res = await GET(
      new Request("http://localhost/api/agents/proj/traces?from=2026-02-31"),
      ctx("proj"),
    );
    expect(res.status).toBe(400);
    expect(traceRepo.listByAgent).not.toHaveBeenCalled();
  });

  it("rejects a reversed range (from > to) with 400", async () => {
    agentRepo.get.mockResolvedValue({ name: "proj", ownerEmail: "owner@example.com" });
    const res = await GET(
      new Request("http://localhost/api/agents/proj/traces?from=2026-07-31&to=2026-07-01"),
      ctx("proj"),
    );
    expect(res.status).toBe(400);
    expect(traceRepo.listByAgent).not.toHaveBeenCalled();
  });
});

describe("GET /api/agents/[name]/traces/[traceId]", () => {
  const oneCtx = (name: string, traceId: string) => ({
    params: Promise.resolve({ name, traceId }),
  });

  it("returns the agent's own trace", async () => {
    agentRepo.get.mockResolvedValue({ name: "proj", ownerEmail: "owner@example.com" });
    traceRepo.get.mockResolvedValue({ traceId: "t1", agentName: "proj" });
    const res = await GET_ONE(req(), oneCtx("proj", "t1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ traceId: "t1", agentName: "proj" });
  });

  it("hides a trace stored under a different agent", async () => {
    // Which agent a trace belongs to is the trace's own record: an owner of
    // one agent must not read another's by guessing ids.
    agentRepo.get.mockResolvedValue({ name: "proj", ownerEmail: "owner@example.com" });
    traceRepo.get.mockResolvedValue({ traceId: "t1", agentName: "other" });
    const res = await GET_ONE(req(), oneCtx("proj", "t1"));
    expect(res.status).toBe(404);
  });
});
