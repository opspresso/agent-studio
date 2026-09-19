import { describe, expect, it, vi } from "vitest";
import { composeCreateAgent } from "@/application/project/createProjectFlow";
import type { CreateProjectInput } from "@/application/project/projectUseCases";
import { ConflictError } from "@/application/errors";
import { getModelConfig } from "@/domain/llm/models";
import type { ProjectRepository } from "@/domain/project/repository";
import type { Project } from "@/domain/project/types";

const INPUT: CreateProjectInput = { name: "my-bot", displayName: "My Bot", description: "", ownerEmail: "owner@example.com" };
function fixture(models = ["openai/gpt-5-mini"]) {
  const rows = new Map<string, Project>();
  const projects = { get: async (name: string) => rows.get(name) ?? null,
    create: vi.fn(async (project: Project) => { rows.set(project.name, project); }) } as unknown as ProjectRepository;
  const offered = vi.fn(async () => models.map(id => getModelConfig(id)!));
  return { rows, projects, offered, create: composeCreateAgent({ projects, offered }) };
}

describe("createAgent", () => {
  it("writes the Agent and initial current settings atomically on the first suitable model", async () => {
    const f = fixture(["openrouter/text-embedding-3-small", "openai/gpt-image-2", "openai/gpt-5-mini"]);
    const project = await f.create(INPUT);
    expect(project.configuration).toEqual({ projectName: INPUT.name, model: "openai/gpt-5-mini", systemPrompt: "",
      parameters: { piiFiltering: false }, skillList: [], mcpList: [], subagentList: [] });
    expect(f.projects.create).toHaveBeenCalledTimes(1);
    expect(f.rows.get(INPUT.name)).toEqual(project);
    expect(project).not.toHaveProperty("publishedVersion");
  });
  it("creates an unconfigured Agent when the deployment offers no suitable model", async () => {
    const f = fixture(["openai/gpt-image-2"]);
    expect((await f.create(INPUT)).configuration).toBeUndefined();
    expect(f.rows.size).toBe(1);
  });
  it("does not leave a partial Project when the atomic creation fails", async () => {
    const f = fixture();
    f.projects.create = async () => { throw new Error("storage unavailable"); };
    await expect(f.create(INPUT)).rejects.toThrow("storage unavailable");
    expect(f.rows.size).toBe(0);
  });
  it("preserves a conflicting Project without changing its settings", async () => {
    const f = fixture();
    const first = await f.create(INPUT);
    await expect(f.create(INPUT)).rejects.toBeInstanceOf(ConflictError);
    expect(f.rows.get(INPUT.name)).toEqual(first);
    expect(f.projects.create).toHaveBeenCalledTimes(1);
  });
});
