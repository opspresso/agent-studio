import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_CAPABILITY_USAGE_CHANGES } from "@/domain/plugin/visibility";

const cases = vi.hoisted(() => ({ getView: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/container", () => ({ capabilityVisibilityUseCases: cases }));
vi.mock("@/lib/session", () => ({
  withAdminAuth: (handler: (user: { email: string }, ...args: unknown[]) => unknown) =>
    (...args: unknown[]) => handler({ email: "admin@example.test" }, ...args),
}));
const { GET, PATCH } = await import("@/app/api/settings/plugins/visibility/route");
const patch = (body: unknown) => PATCH(new Request("https://studio.example.test/api/settings/plugins/visibility", {
  method: "PATCH", body: JSON.stringify(body),
}));
beforeEach(() => { vi.clearAllMocks(); });

describe("admin capability visibility API", () => {
  it("reads the complete safe admin view and forwards the actor on update", async () => {
    const hidden = { plugins: ["org.example.tools"], skills: ["review"], tools: ["github"] };
    const changes = [{ kind: "plugins", name: "org.example.tools", enabled: false }];
    const view = { hidden, plugins: [], skills: [], tools: [] };
    cases.getView.mockResolvedValue(view);
    cases.update.mockResolvedValue(view);
    expect(await (await GET()).json()).toEqual(view);
    expect(await (await patch({ changes })).json()).toEqual(view);
    expect(cases.update).toHaveBeenCalledWith(changes, "admin@example.test");
  });
  it.each([
    { changes: "review" },
    { changes: [{ kind: "plugins", name: "INVALID", enabled: false }] },
    { changes: [{ kind: "skills", name: "../skill", enabled: false }] },
    { changes: [{ kind: "tools", name: "server", enabled: false }], unknown: [] },
    { changes: Array.from({ length: MAX_CAPABILITY_USAGE_CHANGES + 1 }, (_, index) => ({ kind: "tools", name: `server-${index}`, enabled: false })) },
    { changes: [{ kind: "tools", name: "server", enabled: false }, { kind: "tools", name: "server", enabled: true }] },
  ])("rejects malformed or oversized settings before mutation", async body => {
    expect((await patch(body)).status).toBe(400);
    expect(cases.update).not.toHaveBeenCalled();
  });
});
