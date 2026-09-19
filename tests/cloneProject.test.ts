process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

import { describe, expect, it } from "vitest";
import { composeCloneProject } from "@/application/project/cloneProjectFlow";
import type { ConfigurationRefRepos } from "@/application/project/configurationPolicy";
import { ConflictError, ForbiddenError } from "@/application/errors";
import type { ProjectRepository } from "@/domain/project/repository";
import type { Project, AgentConfiguration } from "@/domain/project/types";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";

const OWNER = "owner@x.com";
const CLONER = "cloner@x.com";

// Every reference a copied version names resolves; existence is not under test.
const RESOLVING_REFS = {
  skills: { get: async () => ({}) },
  mcps: { get: async () => ({}) },
  externalAgents: { get: async () => ({}) },
  projects: { get: async () => ({}) },
} as unknown as ConfigurationRefRepos;

function sourceProject(overrides: Partial<Project> = {}): Project {
  return {
    name: "source",
    displayName: "Source",
    description: "the original",
    projectType: "agent",
    ownerEmail: OWNER,
    departmentCode: "eng",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function sourceConfiguration(overrides: Partial<AgentConfiguration> = {}): AgentConfiguration {
  return {
    projectName: "source",

    systemPrompt: "be helpful",

    model: "openai/gpt-5-mini",
    parameters: { piiFiltering: true },
    mcpList: [
      {
        name: "docs",
        headers: { "X-Api-Key": "enc:v1:secret" },
        headerTarget: "sha256-target",
        tools: ["search"],
      },
    ],
    skillList: ["summarize"],
    subagentList: [{ name: "helper", type: "local" }],
    maxTurn: 5,

    ...overrides,
  };
}

function makeRepos(projects: Project[], configurations: AgentConfiguration[]) {
  const projectsByName = new Map<string, Project>(projects.map(project => [project.name, { ...project,
    configuration: configurations.find(configuration => configuration.projectName === project.name) }]));
  const projectRepo = {
    get: async (name: string) => projectsByName.get(name) ?? null,
    create: async (project: Project) => { projectsByName.set(project.name, project); },
    update: async (project: Project) => { projectsByName.set(project.name, project); },
  } as unknown as ProjectRepository;
  return { projectRepo, projectsByName };
}

function makeClone(repos: ReturnType<typeof makeRepos>) {
  return composeCloneProject({
    projects: repos.projectRepo,
    refs: RESOLVING_REFS,
    cipher: secretCipher,
  });
}

const INPUT = { sourceName: "source", name: "copy", displayName: "Copy", userEmail: CLONER };

describe("cloneProject", () => {
  it("copies current settings into an Agent owned by the cloner", async () => {
    const repos = makeRepos(
      [sourceProject({  })],
      [sourceConfiguration()],
    );
    const { project, warning } = await makeClone(repos)(INPUT);

    expect(warning).toBeUndefined();
    expect(project).toMatchObject({
      name: "copy",
      displayName: "Copy",
      description: "the original",
      projectType: "agent",
      ownerEmail: CLONER,
      departmentCode: "eng",
    });
    expect(project).not.toHaveProperty("publishedVersion");
    const copied = [repos.projectsByName.get("copy")!.configuration];
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatchObject({

      systemPrompt: "be helpful",
      model: "openai/gpt-5-mini",
      skillList: ["summarize"],
      subagentList: [{ name: "helper", type: "local" }],
      maxTurn: 5,
    });
  });

  it("drops MCP header overrides but keeps the binding and its tool selection", async () => {
    const repos = makeRepos([sourceProject({  })], [sourceConfiguration()]);
    await makeClone(repos)(INPUT);

    const [binding] = repos.projectsByName.get("copy")!.configuration!.mcpList;
    expect(binding).toEqual({ name: "docs", tools: ["search"] });
  });

  it("creates an unconfigured clone of an unconfigured source, with nothing to warn about", async () => {
    const repos = makeRepos([sourceProject()], []);
    const { project, warning } = await makeClone(repos)(INPUT);

    expect(project.name).toBe("copy");
    expect(warning).toBeUndefined();
    expect(project.configuration).toBeUndefined();
  });

  it("reports a configuration that cannot be copied", async () => {
    const repos = makeRepos([sourceProject()], [sourceConfiguration()]);
    const clone = composeCloneProject({
      projects: repos.projectRepo,
        // Every reference the copied version names fails to resolve.
      refs: {
        skills: { get: async () => null },
        mcps: { get: async () => null },
        externalAgents: { get: async () => null },
        projects: { get: async () => null },
      } as unknown as ConfigurationRefRepos,
      cipher: secretCipher,
    });

    const { project, warning } = await clone(INPUT);

    expect(project.name).toBe("copy");
    expect(warning).toContain("could not be copied");
    expect(project.configuration).toBeUndefined();
  });

  it("clones a private source as a private project with an empty invite list", async () => {
    const repos = makeRepos(
      [sourceProject({ visibility: "private", memberEmails: [CLONER, "other@x.com"] })],
      [sourceConfiguration()],
    );
    const { project } = await makeClone(repos)(INPUT);

    expect(project.visibility).toBe("private");
    expect(project.memberEmails).toBeUndefined();
  });

  it("refuses a private source the caller cannot access", async () => {
    const repos = makeRepos([sourceProject({ visibility: "private" })], [sourceConfiguration()]);
    await expect(makeClone(repos)(INPUT)).rejects.toBeInstanceOf(ForbiddenError);
    expect(repos.projectsByName.has("copy")).toBe(false);
  });

  it("clones a private source for an invited member", async () => {
    const repos = makeRepos(
      [sourceProject({ visibility: "private", memberEmails: [CLONER] })],
      [sourceConfiguration()],
    );
    await expect(makeClone(repos)(INPUT)).resolves.toMatchObject({ project: { name: "copy" } });
  });

  it("refuses a target name that already exists", async () => {
    const repos = makeRepos(
      [sourceProject(), sourceProject({ name: "copy" })],
      [sourceConfiguration()],
    );
    await expect(makeClone(repos)(INPUT)).rejects.toBeInstanceOf(ConflictError);
  });
});
