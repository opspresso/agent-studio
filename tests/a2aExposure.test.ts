import { describe, expect, it, vi } from "vitest";
import type { AgentCard } from "@a2a-js/sdk";
import type { Project, AgentConfiguration } from "@/domain/project/types";
import type { ProjectRepository } from "@/domain/project/repository";
import {
  describeProjectA2a,
  listExposedProjects,
  MAX_CONCURRENT_A2A_EXPOSURE_READS,
  resolveExposedProject,
  type A2aExposureDeps,
} from "@/application/a2a/exposure";

const configuration = (name: string): AgentConfiguration =>
  ({ projectName: name, systemPrompt: "", model: "openai/gpt-5-mini", parameters: { piiFiltering: false }, mcpList: [], skillList: [], subagentList: [] });

const project = (
  name: string,
  configured = false,
  overrides: Partial<Project> = {},
): Project =>
  ({
    name,
    ...(configured ? { configuration: configuration(name) } : {}),
    displayName: name,
    description: `${name} description`,
    projectType: "agent",
    ownerEmail: "owner@example.com",

    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }) as Project;

function makeDeps(
  projects: Project[],
): A2aExposureDeps & {
  buildCard: ReturnType<typeof vi.fn>;
  projectReads: () => number;
  projectLists: () => number;
} {
  const byName = new Map(projects.map((p) => [p.name, p]));
  const buildCard = vi.fn(async (p: Project) => ({ name: p.name }) as unknown as AgentCard);
  let reads = 0;
  let lists = 0;
  return {
    projectReads: () => reads,
    projectLists: () => lists,
    projects: {
      get: async (name: string) => {
        reads += 1;
        return byName.get(name) ?? null;
      },
      list: async () => {
        lists += 1;
        return projects;
      },
    } as unknown as ProjectRepository,
    buildCard,
    cardUrlFor: async (name: string) => `https://studio.example.com/api/a2a/${name}/.well-known/agent-card.json`,
  };
}

describe("A2A exposure", () => {
  it("refuses a project with no current configuration, and never builds it a card", async () => {
    const deps = makeDeps([project("draft-only")]);

    // The JSON-RPC endpoint and the public Agent Card both gate on this.
    expect(await resolveExposedProject(deps, "draft-only")).toBeNull();
    // The list surface omits it.
    expect(await listExposedProjects(deps, "viewer@example.com")).toEqual([]);
    // The console tab reports it as unconfigured with nothing to preview.
    expect(await describeProjectA2a(deps, "draft-only", true)).toEqual({
      configured: false,
      cardUrl: null,
      card: null,
    });
    // A card for an unrunnable project must never be rendered at all.
    expect(deps.buildCard).not.toHaveBeenCalled();
  });

  it("exposes a configured project through every surface", async () => {
    const deps = makeDeps([project("live", true)]);

    const exposed = await resolveExposedProject(deps, "live");
    expect(exposed?.configuration.projectName).toBe("live");
    expect(exposed?.card).toEqual({ name: "live" });

    expect(await listExposedProjects(deps, "viewer@example.com")).toEqual([
      {
        name: "live",
        displayName: "live",
        description: "live description",
        cardUrl: "https://studio.example.com/api/a2a/live/.well-known/agent-card.json",
      },
    ]);

    const described = await describeProjectA2a(deps, "live", true);
    expect(described?.configured).toBe(true);
    expect(described?.card).toEqual({ name: "live" });
  });

  it("lists only projects the viewer may access in one catalog pass", async () => {
    const visible = project("visible", true);
    const hidden = project("hidden", true, {
      visibility: "private",
      ownerEmail: "owner@example.com",
    });
    const deps = makeDeps([visible, hidden]);

    await expect(listExposedProjects(deps, "viewer@example.com")).resolves.toEqual([
      {
        name: "visible",
        displayName: "visible",
        description: "visible description",
        cardUrl: "https://studio.example.com/api/a2a/visible/.well-known/agent-card.json",
      },
    ]);
    expect(deps.projectLists()).toBe(1);
  });

  it("bounds the card URL work a listing keeps in flight", async () => {
    const projects = Array.from({ length: 40 }, (_unused, index) =>
      project(`p${String(index).padStart(2, "0")}`, true),
    );
    const deps = makeDeps(projects);
    let inFlight = 0;
    let peak = 0;
    const inner = deps.cardUrlFor;
    deps.cardUrlFor = async (projectName: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await Promise.resolve();
        return await inner(projectName);
      } finally {
        inFlight -= 1;
      }
    };

    const listed = await listExposedProjects(deps, "owner@example.com");

    expect(listed.map((item) => item.name)).toEqual(projects.map((p) => p.name));
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_A2A_EXPOSURE_READS);
    expect(peak).toBeGreaterThan(1);
  });

  it("hides the card url when A2A is not configured, but still previews the card", async () => {
    const deps = makeDeps([project("live", true)]);
    const described = await describeProjectA2a(deps, "live", false);
    expect(described).toMatchObject({ configured: true, cardUrl: null });
    expect(described?.card).toEqual({ name: "live" });
  });

  it("reads the project once to describe it", async () => {
    const deps = makeDeps([project("live", true)]);
    await describeProjectA2a(deps, "live", true);
    // The console opens this tab on every visit; describing a project it has
    // already loaded must not send a second GetItem for the same key.
    expect(deps.projectReads()).toBe(1);
  });

  it("reports a missing project as null rather than unconfigured", async () => {
    const deps = makeDeps([]);
    expect(await describeProjectA2a(deps, "gone", true)).toBeNull();
    expect(await resolveExposedProject(deps, "gone")).toBeNull();
  });
});
