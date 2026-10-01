import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise actual session/tier wrappers; only identity and use-case boundaries are stubbed.
const f = vi.hoisted(() => ({
  session: vi.fn(), list: vi.fn(), get: vi.fn(), write: vi.fn(), start: vi.fn(),
  enqueue: vi.fn(), cancel: vi.fn(), close: vi.fn(), events: vi.fn(), options: vi.fn(),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: f.session } } }));
vi.mock("@/lib/container", () => ({
  skillUseCases: { list: f.list, get: f.get, create: f.write, update: f.write, remove: f.write },
  mcpUseCases: { list: f.list, get: f.get, create: f.write, update: f.write, remove: f.write },
  mcpAuthUseCases: { completeAuthorization: f.write, abandonAuthorization: f.write },
  pluginUseCases: { list: f.list }, modelRegistryUseCases: { list: f.list },
  modelPreferenceUseCases: { list: f.list, replace: f.write, setFavorite: f.write },
  agentUseCases: { update: f.write, remove: f.write }, configurationUseCases: { put: f.write },
  artifactUseCases: { remove: f.write },
  workspaceUseCases: { start: f.start, enqueue: f.enqueue, cancel: f.cancel, close: f.close, get: f.get, events: f.events },
  workspaceOptions: f.options,
}));

const skills = await import("@/app/api/skills/route");
const skill = await import("@/app/api/skills/[name]/route");
const mcps = await import("@/app/api/mcps/route");
const mcp = await import("@/app/api/mcps/[name]/route");
const plugins = await import("@/app/api/plugins/route");
const models = await import("@/app/api/models/registry/route");
const favorites = await import("@/app/api/models/favorites/route");
const agent = await import("@/app/api/agents/[name]/route");
const configuration = await import("@/app/api/agents/[name]/configuration/route");
const artifact = await import("@/app/api/artifacts/[artifactId]/route");
const workspace = await import("@/app/api/workspaces/route");
const detail = await import("@/app/api/workspaces/[id]/route");
const runs = await import("@/app/api/workspaces/[id]/runs/route");
const events = await import("@/app/api/workspaces/[id]/events/route");
const options = await import("@/app/api/workspaces/options/route");
const mcpCallback = await import("@/app/api/mcps/oauth/callback/route");
const context = { params: Promise.resolve({ name: "demo", id: "workspace-1", artifactId: "file-1" }) };
const request = (method = "GET", body?: unknown) => new Request("https://studio.test/api/test", {
  method, headers: { origin: "https://studio.test", "Content-Type": "application/json", "Idempotency-Key": "request-123" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-10-01T00:00:00Z");
  vi.stubEnv("ADMIN_EMAILS", undefined);
  f.session.mockResolvedValue({ user: { id: "guest-1", email: "guest@example.test", name: "Guest", tier: "guest" } });
  f.list.mockResolvedValue([]);
  f.get.mockResolvedValue({ name: "demo", description: "Example", content: "Read me" });
  f.start.mockResolvedValue({ workspace: { id: "workspace-1" }, run: { id: "run-1" } });
  f.enqueue.mockResolvedValue({ id: "run-2" });
  f.events.mockResolvedValue([]);
  f.options.mockResolvedValue({ enabled: true, agents: [] });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("guest console access", () => {
  it("rejects completing or abandoning MCP authorization after downgrade to guest", async () => {
    f.write.mockResolvedValue({ agentName: "demo", serverName: "tools", error: "Cancelled" });
    for (const query of ["state=pending&code=fixture", "state=pending&error=access_denied"]) {
      expect((await mcpCallback.GET(new Request(`https://studio.test/api/mcps/oauth/callback?${query}`))).status).toBe(403);
    }
    expect(f.write).not.toHaveBeenCalled();
  });
  it("lets a member finish an authorized MCP connection", async () => {
    f.session.mockResolvedValue({ user: { id: "member-1", email: "member@example.test", name: "Member", tier: "member" } });
    f.write.mockResolvedValue({ agentName: "demo", serverName: "tools" });
    const response = await mcpCallback.GET(new Request("https://studio.test/api/mcps/oauth/callback?state=pending&code=fixture"));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Connected tools to demo");
    expect(f.write).toHaveBeenCalledWith({ state: "pending", code: "fixture", userEmail: "member@example.test", iss: undefined });
  });
  const reads = [
    ["skills", () => skills.GET()], ["skill detail", () => skill.GET(request(), context)],
    ["tools", () => mcps.GET()], ["tool detail", () => mcp.GET(request(), context)],
    ["plugins", () => plugins.GET()], ["models", () => models.GET()],
  ] as const;
  it.each(reads)("lets a guest read %s", async (_name, read) => {
    expect((await read()).status).toBe(200);
  });
  it.each(reads)("requires a session to read %s", async (_name, read) => {
    f.session.mockResolvedValue(null);
    expect((await read()).status).toBe(401);
    expect(f.list).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
  });
  it("refuses shared writes even with an empty admin list or a formerly owned Agent", async () => {
    const mutations = [
      () => skills.POST(request("POST", { name: "demo", description: "Demo", content: "x" })),
      () => skill.PUT(request("PUT", { content: "changed" }), context),
      () => skill.DELETE(request("DELETE"), context),
      () => mcps.POST(request("POST", { name: "demo", url: "https://example.test/mcp" })),
      () => mcp.PUT(request("PUT", { description: "changed" }), context),
      () => mcp.DELETE(request("DELETE"), context),
      () => agent.PUT(request("PUT", { description: "changed" }), context),
      () => agent.DELETE(request("DELETE"), context),
      () => configuration.PUT(request("PUT", {}), context),
      () => favorites.PATCH(request("PATCH", { model: "m", favorite: true })),
      () => artifact.DELETE(request("DELETE"), context),
    ];
    for (const mutate of mutations) expect((await mutate()).status).toBe(403);
    expect(f.write).not.toHaveBeenCalled();
  });
  it("permits guest Workspace lifecycle requests using only the session owner", async () => {
    expect((await options.GET()).status).toBe(200);
    expect((await workspace.POST(request("POST", { agentName: "demo", runtime: "command", input: { kind: "command", script: "echo hello" } }))).status).toBe(202);
    expect(f.start).toHaveBeenCalledWith(expect.any(Object), { userId: "guest-1", email: "guest@example.test" }, "request-123");
    expect((await detail.GET(request(), context)).status).toBe(200);
    expect((await events.GET(request(), context)).status).toBe(200);
    expect((await runs.POST(request("POST", { kind: "command", script: "echo next" }), context)).status).toBe(202);
    expect(f.enqueue).toHaveBeenCalledWith("workspace-1", { userId: "guest-1", email: "guest@example.test" }, expect.any(Object), "request-123");
    expect((await runs.DELETE(request("DELETE"), context)).status).toBe(204);
    expect((await detail.DELETE(request("DELETE"), context)).status).toBe(204);
    expect(f.cancel).toHaveBeenCalledWith("workspace-1", "guest@example.test");
    expect(f.close).toHaveBeenCalledWith("workspace-1", "guest@example.test");
  });
});
