import { beforeEach, describe, expect, it, vi } from "vitest";
const { verify, getSessionUser, assertAccessible, isSameOriginMutation } = vi.hoisted(() => ({ verify: vi.fn(), getSessionUser: vi.fn(), assertAccessible: vi.fn(), isSameOriginMutation: vi.fn(async () => true) }));
vi.mock("@/lib/container", () => ({ apiTokenUseCases: { verify }, agentUseCases: { assertAccessible } }));
vi.mock("@/lib/session", () => ({ getSessionUser, isSameOriginMutation, crossOriginForbidden: () => Response.json({ error: "Cross-origin mutation refused" }, { status: 403 }) }));
const { authenticateExecution } = await import("@/app/api/agents/_lib/executionAuth");
const request = (authorization?: string) => new Request("https://studio.example.test/api/agents/agent/predict", { method: "POST", headers: authorization === undefined ? {} : { authorization } });
beforeEach(() => { vi.clearAllMocks(); });

describe("execution request identity", () => {
  it("uses the personal token's verified user and never substitutes a cookie session", async () => {
    verify.mockResolvedValue({ userId: "token-user", email: "token@example.test" });
    getSessionUser.mockResolvedValue({ id: "cookie-user", email: "cookie@example.test" });
    expect(await authenticateExecution(request("Bearer ast_fixture"), "agent")).toEqual({ userId: "token-user", email: "token@example.test", viaToken: true });
    expect(verify).toHaveBeenCalledExactlyOnceWith("agent", "ast_fixture");
    expect(getSessionUser).not.toHaveBeenCalled(); expect(isSameOriginMutation).not.toHaveBeenCalled();
  });
  it("refuses a revoked, inaccessible or unowned token without session fallback", async () => {
    verify.mockResolvedValue(null);
    getSessionUser.mockResolvedValue({ id: "cookie-user", email: "cookie@example.test" });
    const response = await authenticateExecution(request("Bearer ast_invalid"), "agent");
    expect(response).toBeInstanceOf(Response); expect((response as Response).status).toBe(401);
    expect(getSessionUser).not.toHaveBeenCalled();
  });
  it("reports current account or Agent permission denial without switching to another user", async () => {
    const { ForbiddenError } = await import("@/application/errors");
    verify.mockRejectedValueOnce(new ForbiddenError("User no longer has Agent access"));
    expect((await authenticateExecution(request("Bearer ast_fixture"), "agent") as Response).status).toBe(403);
    expect(getSessionUser).not.toHaveBeenCalled();
  });
  it.each(["", "Basic credential", "Bearer"])("refuses an invalid Authorization header %j without switching identities", async authorization => {
    getSessionUser.mockResolvedValue({ id: "cookie-user", email: "cookie@example.test" });
    const response = await authenticateExecution(request(authorization), "agent");
    expect((response as Response).status).toBe(401); expect(getSessionUser).not.toHaveBeenCalled(); expect(verify).not.toHaveBeenCalled();
  });
  it("uses the authenticated session user ID with current Agent access", async () => {
    getSessionUser.mockResolvedValue({ id: "user-id", email: "user@example.test", name: "User", image: null, tier: "guest" });
    const principal = await authenticateExecution(request(), "agent");
    expect(principal).toMatchObject({ userId: "user-id", email: "user@example.test", viaToken: false });
    expect(assertAccessible).toHaveBeenCalledWith("agent", "user@example.test"); expect(isSameOriginMutation).toHaveBeenCalledOnce();
  });
  it("refuses a session without Agent access", async () => {
    getSessionUser.mockResolvedValue({ id: "user-id", email: "user@example.test" });
    const { ForbiddenError } = await import("@/application/errors"); assertAccessible.mockRejectedValueOnce(new ForbiddenError("Agent is private"));
    expect((await authenticateExecution(request(), "agent") as Response).status).toBe(403);
  });
  it("refuses unauthenticated and cross-origin session calls", async () => {
    getSessionUser.mockResolvedValue(null); expect((await authenticateExecution(request(), "agent") as Response).status).toBe(401);
    getSessionUser.mockResolvedValue({ id: "user-id", email: "user@example.test" }); isSameOriginMutation.mockResolvedValueOnce(false);
    expect((await authenticateExecution(request(), "agent") as Response).status).toBe(403); expect(assertAccessible).not.toHaveBeenCalled();
  });
});
