import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemberTier } from "@/domain/member/tiers";

const { createProjectWithInitialVersion, sessionTier, isAdmin } = vi.hoisted(() => ({
  createProjectWithInitialVersion: vi.fn(),
  sessionTier: { value: "member" as string },
  isAdmin: vi.fn(async () => false),
}));

vi.mock("@/lib/session", () => ({
  isAdmin,
  withAuth:
    (handler: (...args: any[]) => unknown) =>
    (...args: any[]) =>
      handler(
        { id: "u1", email: "u@x.com", name: "U", image: null, tier: sessionTier.value },
        ...args,
      ),
}));
vi.mock("@/lib/container", () => ({
  createProjectWithInitialVersion,
  projectUseCases: { list: vi.fn() },
}));

const { POST } = await import("@/app/api/projects/route");

const postRequest = (body: unknown) =>
  new Request("http://test/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const body = { name: "my-bot", displayName: "My Bot", projectType: "agent" };

const signedInAs = (tier: MemberTier) => {
  sessionTier.value = tier;
};

beforeEach(() => {
  vi.clearAllMocks();
  isAdmin.mockResolvedValue(false);
  signedInAs("member");
});

describe("POST /api/projects", () => {
  it("creates for a tier that may create projects", async () => {
    const project = {
      name: "my-bot",
      displayName: "My Bot",
      description: "",
      projectType: "agent",
      ownerEmail: "u@x.com",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    createProjectWithInitialVersion.mockResolvedValue(project);

    const response = await POST(postRequest(body));

    expect(response.status).toBe(201);
    expect(createProjectWithInitialVersion).toHaveBeenCalledWith({
      ...body,
      description: "",
      ownerEmail: "u@x.com",
    });
  });

  it("403s a guest before parsing the body", async () => {
    signedInAs("guest");
    const response = await POST(postRequest(body));
    expect(response.status).toBe(403);
    expect(createProjectWithInitialVersion).not.toHaveBeenCalled();
  });

  it("lets an effective admin create whatever their stored tier reads as", async () => {
    // The ADMIN_EMAILS bootstrap admin's row defaults like everyone else's;
    // tier is additive to permissions, so admin-ness passes the gate.
    signedInAs("guest");
    isAdmin.mockResolvedValue(true);
    createProjectWithInitialVersion.mockResolvedValue({
      name: "my-bot",
      displayName: "My Bot",
      description: "",
      projectType: "agent",
      ownerEmail: "u@x.com",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect((await POST(postRequest(body))).status).toBe(201);
  });
});
