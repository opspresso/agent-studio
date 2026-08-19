import { beforeEach, describe, expect, it, vi } from "vitest";

const { verify, getMemberTier, getSessionUser } = vi.hoisted(() => ({
  verify: vi.fn(),
  getMemberTier: vi.fn(),
  getSessionUser: vi.fn(),
}));

vi.mock("@/lib/container", () => ({ apiTokenUseCases: { verify } }));
vi.mock("@/lib/memberAccess", () => ({ getMemberTier }));
vi.mock("@/lib/session", () => ({ getSessionUser }));

const { authenticateExecution } = await import("@/app/api/projects/_lib/executionAuth");

const request = (bearer?: string) =>
  new Request("http://test/api/projects/p/versions/1/predict", {
    method: "POST",
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("authenticateExecution with a bearer token", () => {
  it("authenticates as the owner when their tier allows tokens", async () => {
    verify.mockResolvedValue("owner@x.com");
    getMemberTier.mockResolvedValue("member");
    await expect(authenticateExecution(request("ast_ok"), "p")).resolves.toEqual({
      email: "owner@x.com",
      viaToken: true,
    });
  });

  it("403s a valid token whose owner's tier does not allow tokens", async () => {
    verify.mockResolvedValue("owner@x.com");
    getMemberTier.mockResolvedValue("guest");
    const result = await authenticateExecution(request("ast_ok"), "p");
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
  });

  it("fails open when the owner's tier cannot be read", async () => {
    verify.mockResolvedValue("owner@x.com");
    getMemberTier.mockResolvedValue(null);
    await expect(authenticateExecution(request("ast_ok"), "p")).resolves.toEqual({
      email: "owner@x.com",
      viaToken: true,
    });
  });

  it("401s an invalid token without reading any tier", async () => {
    verify.mockResolvedValue(null);
    const result = await authenticateExecution(request("ast_bad"), "p");
    expect((result as Response).status).toBe(401);
    expect(getMemberTier).not.toHaveBeenCalled();
  });
});

describe("authenticateExecution with a session", () => {
  it("authenticates the session user without any tier gate", async () => {
    getSessionUser.mockResolvedValue({
      id: "u1",
      email: "u@x.com",
      name: "U",
      image: null,
      tier: "guest",
    });
    const principal = await authenticateExecution(request(), "p");
    expect(principal).toMatchObject({ email: "u@x.com", viaToken: false });
    expect(getMemberTier).not.toHaveBeenCalled();
  });

  it("401s without a session", async () => {
    getSessionUser.mockResolvedValue(null);
    const result = await authenticateExecution(request(), "p");
    expect((result as Response).status).toBe(401);
  });
});
