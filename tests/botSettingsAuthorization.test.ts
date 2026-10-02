import { beforeEach, describe, expect, it, vi } from "vitest";
const updates = vi.hoisted(() => ({ slack: vi.fn(), telegram: vi.fn(), teams: vi.fn() }));
vi.mock("@/lib/container", () => ({ agentSlackUseCases: { update: updates.slack }, agentTelegramUseCases: { update: updates.telegram }, agentTeamsUseCases: { update: updates.teams } }));
vi.mock("@/lib/session", () => {
  const wrap = (handler: (user: { email: string }, request: Request, context: unknown) => unknown) =>
    (request: Request, context: unknown) => handler({ email: "owner@example.test" }, request, context);
  return { withAuth: wrap, withMemberAuth: wrap };
});
vi.mock("@/lib/runtime-settings", () => ({ getServiceBranding: vi.fn() }));
vi.mock("@/lib/public-url", () => ({ resolvePublicBaseUrl: vi.fn() }));
const slack = await import("@/app/api/agents/[name]/slack/route");
const telegram = await import("@/app/api/agents/[name]/telegram/route");
const teams = await import("@/app/api/agents/[name]/teams/route");
beforeEach(() => vi.clearAllMocks());
describe.each([["slack", slack], ["telegram", telegram], ["teams", teams]] as const)("%s settings caller boundary", (kind, routes) => {
  it.each([{ runAsOwner: true }, { executionEmail: "other@example.test" }])("rejects caller overrides %j before saving credentials", async input => {
    const response = await routes.PUT(new Request(`https://studio.example.test/api/agents/demo/${kind}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    }), { params: Promise.resolve({ name: "demo" }) });
    expect(response.status).toBe(400);
    expect(updates[kind]).not.toHaveBeenCalled();
  });
});
