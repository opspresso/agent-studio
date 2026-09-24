import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError } from "@/application/errors";

const { useCases, role, getDefaultModel, getDecisionModelSelection } = vi.hoisted(() => ({
  useCases: { list: vi.fn(), save: vi.fn(), remove: vi.fn(), discover: vi.fn(), selectDefault: vi.fn(), selectDecision: vi.fn() },
  role: { admin: true }, getDefaultModel: vi.fn(), getDecisionModelSelection: vi.fn(),
}));
vi.mock("@/lib/container", () => ({ modelRegistryUseCases: useCases }));
vi.mock("@/lib/runtime-settings", () => ({ getDefaultModel, getDecisionModelSelection }));
vi.mock("@/lib/session", () => ({
  withAdminAuth: (handler: (user: { email: string }, request: Request) => unknown) => (request: Request) => role.admin ? handler({ email: "admin@example.test" }, request) : Response.json({ error: "Forbidden" }, { status: 403 }),
  withMemberAuth: (handler: () => unknown) => () => handler(),
}));
const registry = await import("@/app/api/models/registry/route");
const discovery = await import("@/app/api/models/discover/route");
const defaults = await import("@/app/api/models/default/route");
const decisions = await import("@/app/api/models/decision/route");
const model = { id: "office/model", provider: "office", wireId: "model", displayName: "Model", type: "decision", contextWindow: 0, maxTokens: 0, capabilities: { tools: false, structuredOutput: true, imageInput: false, reasoning: false } };
const request = (method: string, path = "registry", body?: unknown) => new Request(`https://studio.example.test/api/models/${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });

beforeEach(() => { vi.clearAllMocks(); role.admin = true; });
describe("model registry routes", () => {
  it("returns stored selections and accepts all six model types", async () => {
    useCases.list.mockResolvedValue([model]);
    expect(await (await registry.GET()).json()).toEqual({ models: [model] });
    useCases.save.mockResolvedValue([model]);
    for (const type of ["text", "image", "embedding", "rerank", "transcription", "decision"]) {
      expect((await registry.POST(request("POST", "registry", { ...model, type }))).status).toBe(200);
    }
    expect(useCases.save).toHaveBeenLastCalledWith(model, "admin@example.test");
  });
  it("rejects malformed registration before mutation", async () => {
    expect((await registry.POST(request("POST", "registry", { ...model, type: "video" }))).status).toBe(400);
    expect(useCases.save).not.toHaveBeenCalled();
  });
  it("keeps mutations and discovery admin-only", async () => {
    role.admin = false;
    expect((await registry.POST(request("POST", "registry", model))).status).toBe(403);
    expect((await registry.DELETE(request("DELETE", "registry?id=office%2Fmodel"))).status).toBe(403);
    expect((await discovery.GET(request("GET", "discover?provider=office"))).status).toBe(403);
    expect((await defaults.PUT(request("PUT", "default", { model: model.id }))).status).toBe(403);
    expect((await decisions.PUT(request("PUT", "decision", { model: model.id }))).status).toBe(403);
    expect(useCases.save).not.toHaveBeenCalled(); expect(useCases.discover).not.toHaveBeenCalled();
  });
  it("selects or clears a decision model through an admin-only route", async () => {
    getDecisionModelSelection.mockResolvedValue({ model: model.id, source: "override" });
    expect(await (await decisions.GET()).json()).toEqual({ model: model.id });
    expect((await decisions.PUT(request("PUT", "decision", { model: model.id }))).status).toBe(200);
    expect(useCases.selectDecision).toHaveBeenCalledWith(model.id, "admin@example.test");
    expect((await decisions.PUT(request("PUT", "decision", { model: null }))).status).toBe(200);
    expect(useCases.selectDecision).toHaveBeenCalledWith(null, "admin@example.test");
    expect((await decisions.PUT(request("PUT", "decision", { model: 42 }))).status).toBe(400);
  });
  it("reports active selection conflicts without deleting the model", async () => {
    useCases.remove.mockRejectedValue(new ConflictError("Model is active"));
    expect((await registry.DELETE(request("DELETE", "registry?id=office%2Fmodel"))).status).toBe(409);
    expect(useCases.remove).toHaveBeenCalledWith(model.id, "admin@example.test");
  });
  it("discovers only by a registered provider name and saves the default through its use case", async () => {
    useCases.discover.mockResolvedValue([{ wireId: "model" }]);
    expect(await (await discovery.GET(request("GET", "discover?provider=office"))).json()).toEqual({ models: [{ wireId: "model" }] });
    expect(useCases.discover).toHaveBeenCalledWith("office");
    useCases.selectDefault.mockResolvedValue(undefined);
    expect((await defaults.PUT(request("PUT", "default", { model: model.id }))).status).toBe(200);
    expect(useCases.selectDefault).toHaveBeenCalledWith(model.id, "admin@example.test");
  });
});
