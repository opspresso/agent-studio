import { describe, expect, it, vi } from "vitest";
import { createWorkspaceOptionsUseCase } from "@/application/workspace/workspaceOptions";
import type { Project } from "@/domain/project/types";
import type { WorkspaceRepositoryPolicy } from "@/domain/workspace/policyRepository";

function project(name: string, workspaceTools = true): Project {
  return {
    name, displayName: name, description: `${name} description`, ownerEmail: "owner@example.test",
    createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z",
    configuration: {
      projectName: name, systemPrompt: "", model: "openai/model",
      parameters: { piiFiltering: false, workspaceTools }, mcpList: [], skillList: [], subagentList: [],
    },
  };
}

describe("Workspace options", () => {
  it("reads only accessible opted-in projects with bounded parallel policy reads and keeps list order", async () => {
    const projects = Array.from({ length: 10 }, (_, index) => project(`p${index}`));
    projects.push(project("disabled", false));
    const listAccessible = vi.fn(async () => projects);
    let pending = 0;
    let peak = 0;
    const readPolicy = vi.fn(async (name: string): Promise<WorkspaceRepositoryPolicy | null> => {
      pending += 1;
      peak = Math.max(peak, pending);
      await Promise.resolve();
      pending -= 1;
      return name === "p0" ? { projectName: name, revision: 1, updatedAt: "2026-09-24T00:00:00.000Z",
        rules: { mode: "selected", repositories: ["Org/Repo"], defaultRuntime: "codex" } } : null;
    });
    const options = createWorkspaceOptionsUseCase({
      listAccessible, policies: { get: readPolicy }, runtimes: async () => ["command", "codex"],
      backendReady: () => true, gitEnabled: () => true,
    });

    const result = await options("owner@example.test");
    expect(listAccessible).toHaveBeenCalledExactlyOnceWith("owner@example.test");
    expect(readPolicy).toHaveBeenCalledTimes(10);
    expect(result.projects.map((item) => item.projectName)).toEqual(projects.slice(0, 10).map((item) => item.name));
    expect(result.projects[0]).toMatchObject({ defaultRuntime: "codex", mode: "selected", repositories: ["org/repo"] });
    expect(result.projects[1]).toMatchObject({ defaultRuntime: "command", mode: "new", repositories: [] });
    expect(result).toMatchObject({ enabled: true, gitEnabled: true });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it("does not enumerate projects when the Sandbox backend is disabled", async () => {
    const listAccessible = vi.fn(async () => [project("p")]);
    const readPolicy = vi.fn(async () => null);
    const options = createWorkspaceOptionsUseCase({
      listAccessible, policies: { get: readPolicy }, runtimes: async () => ["command"],
      backendReady: () => false, gitEnabled: () => false,
    });
    expect(await options("owner@example.test")).toEqual({ enabled: false, gitEnabled: false, projects: [] });
    expect(listAccessible).not.toHaveBeenCalled();
    expect(readPolicy).not.toHaveBeenCalled();
  });
});
