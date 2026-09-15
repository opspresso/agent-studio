import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError } from "@/application/errors";

const f = vi.hoisted(() => ({ start: vi.fn(), enqueue: vi.fn(), cancel: vi.fn(), close: vi.fn(), get: vi.fn(), events: vi.fn(), request: vi.fn(), decide: vi.fn(), getView: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/session", () => ({
  withMemberAuth: (handler: (user: unknown, ...args: unknown[]) => Promise<Response>) => (...args: unknown[]) => handler({ email: "owner@example.com" }, ...args),
  withAdminAuth: (handler: (user: unknown, ...args: unknown[]) => Promise<Response>) => (...args: unknown[]) => handler({ email: "admin@example.com" }, ...args),
}));
vi.mock("@/lib/container", () => ({ workspaceUseCases: f, getCodingUseCases: () => f, workspaceRepositoryPolicyUseCases: f }));
const start = await import("@/app/api/workspaces/route");
const runs = await import("@/app/api/workspaces/[id]/runs/route");
const detail = await import("@/app/api/workspaces/[id]/route");
const events = await import("@/app/api/workspaces/[id]/events/route");
const actions = await import("@/app/api/workspaces/[id]/actions/route");
const decision = await import("@/app/api/workspaces/[id]/actions/[action]/route");
const policy = await import("@/app/api/projects/[name]/workspace-policy/route");
const context = { params: Promise.resolve({ id: "workspace-1", action: "approval-1" }) };
const request = (path: string, method = "GET", body?: unknown) => new Request(`http://localhost/api/workspaces${path}`, {
  method, headers: { "Content-Type": "application/json", "Idempotency-Key": "stable-request-key" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
beforeEach(() => { vi.clearAllMocks(); f.events.mockResolvedValue([]); });

describe("Workspace HTTP contract", () => {
  it.each(["selected", "owners", "all", "new"])("accepts the explicit %s repository mode", async mode => {
    const body = { revision: null, rules: { mode, repositories: [], repositoryOwners: [], defaultRuntime: "command", idleTtlSeconds: 1800, checks: [], deploymentWorkflows: [] } };
    f.update.mockResolvedValue({ projectName: "demo", rules: body.rules, revision: 1 });
    expect((await policy.PUT(request("/policy", "PUT", body), { params: Promise.resolve({ name: "demo" }) })).status).toBe(200);
    expect(f.update).toHaveBeenCalledWith("demo", body, "owner@example.com");
  });
  it("uses the member identity for project authorization and revision for repository policy writes and rejects compute or wildcard fields", async () => {
    const context = { params: Promise.resolve({ name: "demo" }) };
    f.update.mockResolvedValue({ projectName: "demo", revision: 2 });
    const body = { revision: 1, rules: { mode: "owners", repositories: ["company/repo"], repositoryOwners: ["company"], defaultRuntime: "codex", idleTtlSeconds: 300, checks: [{ name: "test", command: "pnpm test" }], deploymentWorkflows: [] } };
    expect((await policy.PUT(request("/policy", "PUT", body), context)).status).toBe(200);
    expect(f.update).toHaveBeenCalledWith("demo", body, "owner@example.com");
    for (const invalid of [{ ...body, rules: { ...body.rules, image: "host-shell" } }, { ...body, rules: { ...body.rules, repositoryOwners: ["*"] } }, { ...body, revision: -1 }]) {
      expect((await policy.PUT(request("/policy", "PUT", invalid), context)).status).toBe(400);
    }
    expect(f.update).toHaveBeenCalledTimes(1);
    expect((await policy.PUT(request("/policy", "PUT", { revision: 2, rules: null }), context)).status).toBe(400);
    f.getView.mockResolvedValue({ projectName: "demo", canManage: false });
    expect((await policy.GET(request("/policy"), context)).status).toBe(200);
    expect(f.getView).toHaveBeenCalledWith("demo", "owner@example.com");
  });
  it("forwards creation identity and member ownership and validates the runtime at the boundary", async () => {
    const input = { projectName: "demo", runtime: "codex", input: { kind: "task", prompt: "Make a report" } };
    f.start.mockResolvedValue({ workspace: { id: "workspace-1" }, run: { id: "run-1" } });
    expect((await start.POST(request("", "POST", input))).status).toBe(202);
    expect(f.start).toHaveBeenCalledWith(input, "owner@example.com", "stable-request-key");
    expect((await start.POST(request("", "POST", { ...input, runtime: "host-shell" }))).status).toBe(400);
    expect(f.start).toHaveBeenCalledTimes(1);
  });
  it("strips worker control fields from newly enqueued run responses", async () => {
    f.enqueue.mockResolvedValue({ id: "run-1", status: "queued", requestKey: "internal", leaseToken: "lease", operationId: "op", protocolBuffer: "native" });
    const response = await runs.POST(request("/workspace-1/runs", "POST", { kind: "command", script: "echo hello" }), context);
    expect(await response.json()).toEqual({ run: { id: "run-1", status: "queued" } });
    expect(f.enqueue).toHaveBeenCalledWith("workspace-1", "owner@example.com", { kind: "command", script: "echo hello" }, "stable-request-key");
  });
  it("preserves zero event cursors and refuses invalid cursors before reading", async () => {
    const response = await events.GET(request("/workspace-1/events?run=run-1&after=0"), context);
    expect(await response.json()).toEqual({ events: [], nextSeq: 0, hasMore: false });
    expect(f.events).toHaveBeenCalledWith("workspace-1", "owner@example.com", "run-1", 0);
    expect((await events.GET(request("/workspace-1/events?after=-1"), context)).status).toBe(400);
    expect(f.events).toHaveBeenCalledTimes(1);
  });
  it("keeps foreign workspaces hidden and distinguishes stopping a run from finishing a workspace", async () => {
    f.get.mockRejectedValueOnce(new NotFoundError("Workspace not found"));
    expect((await detail.GET(request("/workspace-1"), context)).status).toBe(404);
    expect((await runs.DELETE(request("/workspace-1/runs", "DELETE"), context)).status).toBe(204);
    expect(f.cancel).toHaveBeenCalledWith("workspace-1", "owner@example.com");
    expect(f.close).not.toHaveBeenCalled();
    expect((await detail.DELETE(request("/workspace-1", "DELETE"), context)).status).toBe(204);
    expect(f.close).toHaveBeenCalledWith("workspace-1", "owner@example.com");
  });
  it.each(["commit", "commit-and-push", "push"])("prepares %s separately from an explicit approval decision", async kind => {
    const action = kind === "push" ? { kind } : { kind, message: "chore: bump release" };
    f.request.mockResolvedValue({ id: "approval-1", status: "pending" });
    expect((await actions.POST(request("/workspace-1/actions", "POST", action), context)).status).toBe(200);
    expect(f.request).toHaveBeenCalledWith("workspace-1", "owner@example.com", action);
    expect(f.decide).not.toHaveBeenCalled();
    expect((await decision.POST(request("/workspace-1/actions/approval-1", "POST", { approve: "yes" }), context)).status).toBe(400);
    f.decide.mockResolvedValue({ id: "approval-1", status: "rejected" });
    await decision.POST(request("/workspace-1/actions/approval-1", "POST", { approve: false }), context);
    expect(f.decide).toHaveBeenCalledWith("workspace-1", "owner@example.com", "approval-1", false);
  });
});
