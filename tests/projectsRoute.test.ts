import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemberTier } from "@/domain/member/tiers";

const { createAgent, sessionTier } = vi.hoisted(() => ({
  createAgent: vi.fn(),
  sessionTier: { value: "member" as string },
}));

vi.mock("@/lib/session", () => ({
  withAuth:
    (handler: (...args: any[]) => unknown) =>
    (...args: any[]) =>
      handler(
        { id: "u1", email: "u@x.com", name: "U", image: null, tier: sessionTier.value },
        ...args,
      ),
}));
vi.mock("@/lib/container", () => ({
  createAgent,
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
    createAgent.mockResolvedValue(project);

    const response = await POST(postRequest(body));

    expect(response.status).toBe(201);
    expect(createAgent).toHaveBeenCalledWith({
      ...body,
      description: "",
      ownerEmail: "u@x.com",
    });
  });

  it.each(["llm", "image"])("rejects the removed %s type before creating a project", async (projectType) => {
    const response = await POST(postRequest({ ...body, projectType }));
    expect(response.status).toBe(400);
    expect(createAgent).not.toHaveBeenCalled();
  });

  it("creates an Agent when the request has no type selector", async () => {
    createAgent.mockResolvedValue({ ...body, ownerEmail: "u@x.com" });
    expect((await POST(postRequest({ name: body.name, displayName: body.displayName }))).status).toBe(201);
    expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({ projectType: "agent" }));
  });

  it("403s a guest before parsing the body", async () => {
    signedInAs("guest");
    const response = await POST(postRequest(body));
    expect(response.status).toBe(403);
    expect(createAgent).not.toHaveBeenCalled();
  });

  it("does not let admin-list access widen a guest tier", async () => {
    signedInAs("guest");
    expect((await POST(postRequest(body))).status).toBe(403);
    expect(createAgent).not.toHaveBeenCalled();
  });
});
