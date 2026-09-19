process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

import { describe, expect, it, vi } from "vitest";
import { composeCreateProjectWithInitialVersion } from "@/application/project/createProjectFlow";
import type { CreateProjectInput } from "@/application/project/projectUseCases";
import type { VersionRefRepos } from "@/application/project/versionUseCases";
import { ConflictError } from "@/application/errors";
import { getModelConfig, type ModelConfig } from "@/domain/llm/models";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import type { Project, Version } from "@/domain/project/types";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";

const INPUT: CreateProjectInput = {
  name: "my-bot",
  displayName: "My Bot",
  description: "",
  projectType: "agent",
  ownerEmail: "owner@example.com",
};

// Reference lookups are never consulted for the empty binding lists an initial
// version carries; a member access would throw and fail the test.
const UNTOUCHED_REFS = {} as VersionRefRepos;

function makeRepos() {
  const projects = new Map<string, Project>();
  const versions: Version[] = [];
  const projectRepo = {
    async get(name: string) {
      return projects.get(name) ?? null;
    },
    async create(project: Project) {
      projects.set(project.name, project);
    },
  } as ProjectRepository;
  const versionRepo = {
    async list(projectName: string, limit: number, after?: string) {
      return versions
        .filter((version) => version.projectName === projectName)
        .sort((a, b) => a.versionName.localeCompare(b.versionName))
        .filter((version) => !after || version.versionName > after)
        .slice(0, limit);
    },
    async create(version: Version) {
      versions.push(version);
    },
  } as VersionRepository;
  return { projectRepo, versionRepo, versions };
}

function makeFlow(repos: ReturnType<typeof makeRepos>, offered: () => Promise<ModelConfig[]>) {
  return composeCreateProjectWithInitialVersion({
    projects: repos.projectRepo,
    versions: repos.versionRepo,
    refs: UNTOUCHED_REFS,
    cipher: secretCipher,
    offered,
  });
}

function config(id: string): ModelConfig {
  const model = getModelConfig(id);
  if (!model) {
    throw new Error(`test model "${id}" left the registry`);
  }
  return model;
}

describe("createProjectWithInitialVersion", () => {
  it("creates the project and an empty version \"1\" on the first fitting offered model", async () => {
    const repos = makeRepos();
    // Embedding and image models ahead of the chat model must both be skipped.
    const flow = makeFlow(repos, async () => [
      config("openrouter/text-embedding-3-small"),
      config("openai/gpt-image-2"),
      config("openai/gpt-5-mini"),
    ]);

    const project = await flow(INPUT);

    expect(project.name).toBe("my-bot");
    expect(project.publishedVersion).toBeUndefined();
    expect(repos.versions).toHaveLength(1);
    expect(repos.versions[0]).toMatchObject({
      projectName: "my-bot",
      versionName: "1",
      model: "openai/gpt-5-mini",
      systemPrompt: "",
      userPromptTemplate: "",
      mcpList: [],
      skillList: [],
      subagentList: [],
    });
  });


  it("creates only the project when nothing offered fits", async () => {
    const repos = makeRepos();
    const flow = makeFlow(repos, async () => [config("openai/gpt-image-2")]);

    const project = await flow(INPUT);

    expect(project.name).toBe("my-bot");
    expect(repos.versions).toHaveLength(0);
  });

  it("returns the project even when the initial version cannot be created", async () => {
    const repos = makeRepos();
    repos.versionRepo.create = async () => {
      throw new Error("storage blip");
    };
    const flow = makeFlow(repos, async () => [config("openai/gpt-5-mini")]);

    const project = await flow(INPUT);

    expect(project.name).toBe("my-bot");
    expect(repos.versions).toHaveLength(0);
  });

  it("propagates a name conflict without consulting the offered models", async () => {
    const repos = makeRepos();
    const initialModel = vi.fn(async () => [config("openai/gpt-5-mini")]);
    const flow = makeFlow(repos, initialModel);
    await repos.projectRepo.create({
      name: "taken",
      displayName: "Taken",
      description: "",
      projectType: "agent",
      ownerEmail: "owner@example.com",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    await expect(flow({ ...INPUT, name: "taken" })).rejects.toBeInstanceOf(ConflictError);
    expect(initialModel).not.toHaveBeenCalled();
  });
});
