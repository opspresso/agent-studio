import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_HIDDEN_CAPABILITIES } from "@/domain/plugin/visibility";

const cases = vi.hoisted(() => ({ getView: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/container", () => ({ capabilityVisibilityUseCases: cases }));
vi.mock("@/lib/session", () => ({
  withAdminAuth: (handler: (user: { email: string }, ...args: unknown[]) => unknown) =>
    (...args: unknown[]) => handler({ email: "admin@example.test" }, ...args),
}));
const { GET, PUT } = await import("@/app/api/settings/plugins/visibility/route");
const put = (body: unknown) => PUT(new Request("https://studio.example.test/api/settings/plugins/visibility", {
  method: "PUT", body: JSON.stringify(body),
}));
beforeEach(() => { vi.clearAllMocks(); });

describe("admin capability visibility API", () => {
  it("reads the complete safe admin view and forwards the actor on update", async () => {
    const hidden = { plugins: ["org.example.tools"], skills: ["review"], tools: ["github"] };
    const view = { hidden, plugins: [], skills: [], tools: [] };
    cases.getView.mockResolvedValue(view);
    cases.update.mockResolvedValue(view);
    expect(await (await GET()).json()).toEqual(view);
    expect(await (await put(hidden)).json()).toEqual(view);
    expect(cases.update).toHaveBeenCalledWith(hidden, "admin@example.test");
  });
  it.each([
    { plugins: [], skills: "review", tools: [] },
    { plugins: ["INVALID"], skills: [], tools: [] },
    { plugins: [], skills: ["../skill"], tools: [] },
    { plugins: [], skills: [], tools: [], unknown: [] },
    { plugins: [], skills: [], tools: Array(MAX_HIDDEN_CAPABILITIES + 1).fill("server") },
  ])("rejects malformed or oversized settings before mutation", async body => {
    expect((await put(body)).status).toBe(400);
    expect(cases.update).not.toHaveBeenCalled();
  });
});
