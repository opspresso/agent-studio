import { beforeEach, describe, expect, it, vi } from "vitest";

const { listExposedProjects, a2aSurfaceEnabled, exposureDeps } = vi.hoisted(() => ({
  listExposedProjects: vi.fn(),
  a2aSurfaceEnabled: vi.fn(),
  exposureDeps: {},
}));

vi.mock("@/lib/session", () => ({
  withAuth:
    (handler: (user: { email: string }) => Promise<Response>) =>
    () =>
      handler({ email: "viewer@example.com" }),
}));
vi.mock("@/lib/container", () => ({ a2aExposureDeps: exposureDeps }));
vi.mock("@/application/a2a/exposure", () => ({ listExposedProjects }));
vi.mock("@/app/api/a2a/_lib/auth", () => ({ a2aSurfaceEnabled }));

const { GET } = await import("@/app/api/a2a/route");

beforeEach(() => {
  vi.clearAllMocks();
  a2aSurfaceEnabled.mockResolvedValue(true);
  listExposedProjects.mockResolvedValue([
    {
      name: "visible",
      displayName: "Visible",
      description: "Visible agent",
      cardUrl: "https://studio.example.com/api/a2a/visible/.well-known/agent-card.json",
    },
  ]);
});

describe("A2A project list route", () => {
  it("delegates visibility and exposure to one catalog read", async () => {
    const response = await GET();

    expect(listExposedProjects).toHaveBeenCalledWith(exposureDeps, "viewer@example.com");
    await expect(response.json()).resolves.toEqual({
      enabled: true,
      projects: [
        {
          name: "visible",
          displayName: "Visible",
          description: "Visible agent",
          cardUrl: "https://studio.example.com/api/a2a/visible/.well-known/agent-card.json",
        },
      ],
    });
  });
});
