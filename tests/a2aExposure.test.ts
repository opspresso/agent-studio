/**
 * A2A exposure policy. The four A2A surfaces — the project list, the public
 * Agent Card, the JSON-RPC endpoint and the console's A2A tab — all resolve
 * through this one use case, so "published-only" is asserted once here instead
 * of being re-checked per route (which is how the four copies drifted apart).
 */

import { describe, expect, it, vi } from "vitest";
import type { AgentCard } from "@a2a-js/sdk";
import type { Project, Version } from "@/domain/project/types";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import {
  describeProjectA2a,
  listExposedProjects,
  resolveExposedProject,
  type A2aExposureDeps,
} from "@/application/a2a/exposure";

const version = (name: string): Version =>
  ({ versionName: name, systemPrompt: "", userPromptTemplate: "", model: "openai/gpt-5-mini" }) as Version;

const project = (
  name: string,
  publishedVersion?: string,
  overrides: Partial<Project> = {},
): Project =>
  ({
    name,
    displayName: name,
    description: `${name} description`,
    projectType: "agent",
    ownerEmail: "owner@example.com",
    publishedVersion,
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
    versions: {
      // Mirrors the real port: the repository resolves the literal "published"
      // through the project's pointer, so a project without one gets null.
      get: async (projectName: string, versionName: string) => {
        if (versionName !== "published") {
          return version(versionName);
        }
        const pointer = byName.get(projectName)?.publishedVersion;
        return pointer ? version(pointer) : null;
      },
    } as unknown as VersionRepository,
    buildCard,
    cardUrlFor: async (name: string) => `https://studio.example.com/api/a2a/${name}/.well-known/agent-card.json`,
  };
}

describe("A2A exposure", () => {
  it("refuses a project with no published version, and never builds it a card", async () => {
    const deps = makeDeps([project("draft-only")]);

    // The JSON-RPC endpoint and the public Agent Card both gate on this.
    expect(await resolveExposedProject(deps, "draft-only")).toBeNull();
    // The list surface omits it.
    expect(await listExposedProjects(deps, "viewer@example.com")).toEqual([]);
    // The console tab reports it as unpublished with nothing to preview.
    expect(await describeProjectA2a(deps, "draft-only", true)).toEqual({
      published: false,
      cardUrl: null,
      card: null,
    });
    // A card for an unrunnable project must never be rendered at all.
    expect(deps.buildCard).not.toHaveBeenCalled();
  });

  it("exposes a published project through every surface", async () => {
    const deps = makeDeps([project("live", "3")]);

    const exposed = await resolveExposedProject(deps, "live");
    expect(exposed?.version.versionName).toBe("3");
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
    expect(described?.published).toBe(true);
    expect(described?.card).toEqual({ name: "live" });
  });

  it("lists only projects the viewer may access in one catalog pass", async () => {
    const visible = project("visible", "1");
    const hidden = project("hidden", "1", {
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

  it("hides the card url when A2A is not configured, but still previews the card", async () => {
    const deps = makeDeps([project("live", "3")]);
    const described = await describeProjectA2a(deps, "live", false);
    expect(described).toMatchObject({ published: true, cardUrl: null });
    expect(described?.card).toEqual({ name: "live" });
  });

  it("reads the project once to describe it", async () => {
    const deps = makeDeps([project("live", "3")]);
    await describeProjectA2a(deps, "live", true);
    // The console opens this tab on every visit; describing a project it has
    // already loaded must not send a second GetItem for the same key.
    expect(deps.projectReads()).toBe(1);
  });

  it("reports a missing project as null rather than unpublished", async () => {
    const deps = makeDeps([]);
    expect(await describeProjectA2a(deps, "gone", true)).toBeNull();
    expect(await resolveExposedProject(deps, "gone")).toBeNull();
  });
});
