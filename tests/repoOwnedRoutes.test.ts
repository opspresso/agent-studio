import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The console's refusal to mutate repo-owned entries (`repoOwnedRefusal`,
 * src/app/api/_lib/repoOwned.ts) is a route-layer policy on purpose: the
 * plugins sync updates and deletes exactly these entries through the same use
 * cases, so the use cases must stay willing. These tests pin the boundary —
 * what the console refuses, and the credential carve-out it must not take.
 */
const { skillUseCases, mcpUseCases, managedMcpUseCases } = vi.hoisted(() => ({
  skillUseCases: { get: vi.fn(), update: vi.fn(), remove: vi.fn() },
  mcpUseCases: { get: vi.fn(), update: vi.fn(), remove: vi.fn() },
  managedMcpUseCases: { update: vi.fn(), remove: vi.fn(), status: vi.fn() },
}));

vi.mock("@/lib/session", () => ({
  withAuth:
    (handler: (...args: any[]) => unknown) =>
    (...args: any[]) =>
      handler(...args),
  withAdminAuth:
    (handler: (user: unknown, ...args: any[]) => unknown) =>
    (...args: any[]) =>
      handler({ id: "u1", email: "admin@example.com", name: "A", image: null }, ...args),
}));
vi.mock("@/lib/container", () => ({ skillUseCases, mcpUseCases, managedMcpUseCases }));

const skillsRoute = await import("@/app/api/skills/[name]/route");
const mcpsRoute = await import("@/app/api/mcps/[name]/route");
const managedRoute = await import("@/app/api/mcps/managed/[name]/route");

const SOURCE = "github:opspresso/agent-plugins#devops";

const ctx = (name: string) => ({ params: Promise.resolve({ name }) });
const req = (body: unknown) =>
  new Request("https://studio.example.com/api/x", { method: "PUT", body: JSON.stringify(body) });
const del = new Request("https://studio.example.com/api/x", { method: "DELETE" });

beforeEach(() => {
  vi.clearAllMocks();
  skillUseCases.update.mockResolvedValue({ name: "s" });
  mcpUseCases.update.mockResolvedValue({ name: "m" });
  managedMcpUseCases.update.mockResolvedValue({ name: "m" });
});

describe("skills — a repo-owned skill has no console mutations", () => {
  it("403s an edit and names the owner", async () => {
    skillUseCases.get.mockResolvedValue({ name: "gitops", source: SOURCE });
    const res = await skillsRoute.PUT(req({ description: "edited" }), ctx("gitops"));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain(SOURCE);
    expect(skillUseCases.update).not.toHaveBeenCalled();
  });

  it("403s a delete — removal goes through the sync's orphan selection", async () => {
    skillUseCases.get.mockResolvedValue({ name: "gitops", source: SOURCE });
    const res = await skillsRoute.DELETE(del, ctx("gitops"));
    expect(res.status).toBe(403);
    expect(skillUseCases.remove).not.toHaveBeenCalled();
  });

  it("leaves a hand-written skill fully editable", async () => {
    skillUseCases.get.mockResolvedValue({ name: "mine" });
    expect((await skillsRoute.PUT(req({ description: "edited" }), ctx("mine"))).status).toBe(200);
    expect(skillUseCases.update).toHaveBeenCalledWith("mine", { description: "edited" });
    expect((await skillsRoute.DELETE(del, ctx("mine"))).status).toBe(204);
    expect(skillUseCases.remove).toHaveBeenCalledWith("mine", "admin@example.com");
  });
});

describe("mcps — the repo owns the document, the console keeps the credentials", () => {
  it("403s a document-field edit on a synced server", async () => {
    mcpUseCases.get.mockResolvedValue({ name: "argocd", source: SOURCE });
    for (const patch of [{ url: "https://x.test/mcp" }, { description: "d" }, { content: "c" }]) {
      const res = await mcpsRoute.PUT(req(patch), ctx("argocd"));
      expect(res.status).toBe(403);
    }
    expect(mcpUseCases.update).not.toHaveBeenCalled();
  });

  it("lets a headers-only patch through — that is where the token goes", async () => {
    const res = await mcpsRoute.PUT(req({ headers: { Authorization: "tok" } }), ctx("argocd"));
    expect(res.status).toBe(200);
    // No document field named, so the stored entry was not even consulted.
    expect(mcpUseCases.get).not.toHaveBeenCalled();
    expect(mcpUseCases.update).toHaveBeenCalledWith("argocd", {
      headers: { Authorization: "tok" },
    });
  });

  it("403s a delete of a synced server", async () => {
    mcpUseCases.get.mockResolvedValue({ name: "argocd", source: SOURCE });
    const res = await mcpsRoute.DELETE(del, ctx("argocd"));
    expect(res.status).toBe(403);
    expect(mcpUseCases.remove).not.toHaveBeenCalled();
  });

  it("leaves a hand-registered server fully editable", async () => {
    mcpUseCases.get.mockResolvedValue({ name: "mine" });
    const res = await mcpsRoute.PUT(req({ url: "https://x.test/mcp" }), ctx("mine"));
    expect(res.status).toBe(200);
    expect((await mcpsRoute.DELETE(del, ctx("mine"))).status).toBe(204);
  });
});

describe("managed mcps — the console keeps the workload, the repo keeps the document", () => {
  it("403s a description/content edit on a synced managed entry", async () => {
    mcpUseCases.get.mockResolvedValue({ name: "memory", source: SOURCE, runtime: "managed" });
    const res = await managedRoute.PUT(req({ description: "d" }), ctx("memory"));
    expect(res.status).toBe(403);
    expect(managedMcpUseCases.update).not.toHaveBeenCalled();
  });

  it("lets a workload-only patch through", async () => {
    const res = await managedRoute.PUT(req({ image: "ghcr.io/x/y:2" }), ctx("memory"));
    expect(res.status).toBe(200);
    expect(mcpUseCases.get).not.toHaveBeenCalled();
    expect(managedMcpUseCases.update).toHaveBeenCalledWith("memory", { image: "ghcr.io/x/y:2" });
  });

  it("403s a delete of a synced managed entry", async () => {
    mcpUseCases.get.mockResolvedValue({ name: "memory", source: SOURCE, runtime: "managed" });
    const res = await managedRoute.DELETE(del, ctx("memory"));
    expect(res.status).toBe(403);
    expect(managedMcpUseCases.remove).not.toHaveBeenCalled();
  });
});
