import { describe, expect, it, vi } from "vitest";
import { createWorkspaceOptionsUseCase } from "@/application/workspace/workspaceOptions";
import type { Agent } from "@/domain/agent/types";
import type { WorkspaceRepositoryPolicy } from "@/domain/workspace/policyRepository";

function agent(name: string, workspaceTools = true): Agent {
  return {
    name, displayName: name, description: `${name} description`, ownerEmail: "owner@example.test",
    createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z",
    configuration: {
      agentName: name, systemPrompt: "", model: "openai/model",
      parameters: { piiFiltering: false, workspaceTools }, mcpList: [], skillList: [], subagentList: [],
    },
  };
}

describe("Workspace options", () => {
  it("reads only accessible opted-in agents with bounded parallel policy reads and keeps list order", async () => {
    const agents = Array.from({ length: 10 }, (_, index) => agent(`p${index}`));
    agents.push(agent("disabled", false));
    const listAccessible = vi.fn(async () => agents);
    let pending = 0;
    let peak = 0;
    const readPolicy = vi.fn(async (name: string): Promise<WorkspaceRepositoryPolicy | null> => {
      pending += 1;
      peak = Math.max(peak, pending);
      await Promise.resolve();
      pending -= 1;
      return name === "p0" ? { agentName: name, revision: 1, updatedAt: "2026-09-24T00:00:00.000Z",
        rules: { mode: "selected", repositories: ["Org/Repo"], defaultRuntime: "codex" } } : null;
    });
    const options = createWorkspaceOptionsUseCase({
      listAccessible, policies: { get: readPolicy }, runtimes: async () => ["command", "codex"],
      backendReady: () => true, gitEnabled: () => true,
    });

    const result = await options("owner@example.test");
    expect(listAccessible).toHaveBeenCalledExactlyOnceWith("owner@example.test");
    expect(readPolicy).toHaveBeenCalledTimes(10);
    expect(result.agents.map((item) => item.agentName)).toEqual(agents.slice(0, 10).map((item) => item.name));
    expect(result.agents[0]).toMatchObject({ defaultRuntime: "codex", mode: "selected", repositories: ["org/repo"] });
    expect(result.agents[1]).toMatchObject({ defaultRuntime: "command", mode: "new", repositories: [] });
    expect(result).toMatchObject({ enabled: true, gitEnabled: true });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it("does not enumerate agents when the Sandbox backend is disabled", async () => {
    const listAccessible = vi.fn(async () => [agent("p")]);
    const readPolicy = vi.fn(async () => null);
    const options = createWorkspaceOptionsUseCase({
      listAccessible, policies: { get: readPolicy }, runtimes: async () => ["command"],
      backendReady: () => false, gitEnabled: () => false,
    });
    expect(await options("owner@example.test")).toEqual({ enabled: false, gitEnabled: false, agents: [] });
    expect(listAccessible).not.toHaveBeenCalled();
    expect(readPolicy).not.toHaveBeenCalled();
  });
});
