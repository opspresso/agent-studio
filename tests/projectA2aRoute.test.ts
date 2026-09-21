import { AgentCard } from "@a2a-js/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "@/application/errors";
import type { Project } from "@/domain/project/types";

const { assertAccessible, getProject, buildCard, cardUrlFor, surfaceEnabled } = vi.hoisted(() => ({
  assertAccessible: vi.fn(), getProject: vi.fn(), buildCard: vi.fn(), cardUrlFor: vi.fn(), surfaceEnabled: vi.fn(),
}));
type RouteContext = { params: Promise<{ name: string }> };
vi.mock("@/lib/session", () => ({
  withAuth: (handler: (user: { email: string }, request: Request, context: RouteContext) => Promise<Response>) =>
    (request: Request, context: RouteContext) => handler({ email: "owner@example.test" }, request, context),
}));
vi.mock("@/lib/container", () => ({
  projectUseCases: { assertAccessible },
  a2aExposureDeps: { projects: { get: getProject }, buildCard, cardUrlFor },
}));
vi.mock("@/app/api/a2a/_lib/auth", () => ({ a2aSurfaceEnabled: surfaceEnabled }));
const { GET } = await import("@/app/api/projects/[name]/a2a/route");

const CARD = AgentCard.fromJSON({ name: "Project preview" });
const CARD_URL = "https://studio.example.test/api/a2a/fixture/.well-known/agent-card.json";
let project: Project;
const read = () => GET(new Request("https://studio.example.test/api/projects/fixture/a2a"), { params: Promise.resolve({ name: "fixture" }) });

beforeEach(() => {
  vi.clearAllMocks();
  project = {
    name: "fixture", displayName: "Fixture", description: "Agent", projectType: "agent", ownerEmail: "owner@example.test",
    configuration: { projectName: "fixture", systemPrompt: "", model: "provider/model", parameters: { piiFiltering: false }, mcpList: [], skillList: [], subagentList: [] },
    createdAt: "2026-09-21T00:00:00Z", updatedAt: "2026-09-21T00:00:00Z",
  };
  assertAccessible.mockImplementation(async () => project);
  getProject.mockImplementation(async () => project);
  buildCard.mockResolvedValue(CARD);
  cardUrlFor.mockResolvedValue(CARD_URL);
  surfaceEnabled.mockResolvedValue(true);
});

describe("authenticated project A2A preview", () => {
  it.each([
    { visibility: "public" as const, enabled: true, cardUrl: CARD_URL },
    { visibility: "private" as const, enabled: true, cardUrl: null },
    { visibility: "public" as const, enabled: false, cardUrl: null },
    { visibility: "private" as const, enabled: false, cardUrl: null },
  ])("keeps the $visibility preview with inbound=$enabled and reports public URL availability", async ({ visibility, enabled, cardUrl }) => {
    project.visibility = visibility;
    surfaceEnabled.mockResolvedValue(enabled);
    const response = await read();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ enabled, configured: true, cardUrl, card: JSON.parse(JSON.stringify(CARD)) });
    expect(assertAccessible).toHaveBeenCalledExactlyOnceWith("fixture", "owner@example.test");
    expect(buildCard).toHaveBeenCalledExactlyOnceWith(project);
  });

  it("preserves the public URL when visibility is absent", async () => {
    await expect((await read()).json()).resolves.toMatchObject({ cardUrl: CARD_URL, card: { name: CARD.name } });
  });

  it("retains the existing access refusal before constructing a card", async () => {
    assertAccessible.mockRejectedValue(new ForbiddenError("Project is private"));
    const response = await read();
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Project is private" });
    expect(getProject).not.toHaveBeenCalled();
    expect(buildCard).not.toHaveBeenCalled();
  });

  it("does not advertise a card when Agent settings are absent", async () => {
    delete project.configuration;
    await expect((await read()).json()).resolves.toEqual({ enabled: true, configured: false, cardUrl: null, card: null });
    expect(buildCard).not.toHaveBeenCalled();
  });
});
