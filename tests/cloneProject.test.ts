process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

import { describe, expect, it } from "vitest";
import { composeCloneProject } from "@/application/project/cloneProjectFlow";
import type { VersionRefRepos } from "@/application/project/versionUseCases";
import { ConflictError, ForbiddenError } from "@/application/errors";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import type { Project, Version } from "@/domain/project/types";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";

const OWNER = "owner@x.com";
const CLONER = "cloner@x.com";

// Every reference a copied version names resolves; existence is not under test.
const RESOLVING_REFS = {
  skills: { get: async () => ({}) },
  mcps: { get: async () => ({}) },
  externalAgents: { get: async () => ({}) },
  projects: { get: async () => ({}) },
} as unknown as VersionRefRepos;

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

function sourceVersion(overrides: Partial<Version> = {}): Version {
  return {
    projectName: "source",
    versionName: "1",
    systemPrompt: "be helpful",
    userPromptTemplate: "",
    model: "openai/gpt-5-mini",
    parameters: { piiFiltering: true },
    mcpList: [
      { name: "docs", headers: { "X-Api-Key": "enc:v1:secret" }, tools: ["search"] },
    ],
    skillList: ["summarize"],
    subagentList: [{ name: "helper", type: "local" }],
    maxTurn: 5,
    createdAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function makeRepos(projects: Project[], versions: Version[]) {
  const projectsByName = new Map(projects.map((p) => [p.name, p]));
  const stored: Version[] = [...versions];
  const projectRepo = {
    async get(name: string) {
      return projectsByName.get(name) ?? null;
    },
    async create(project: Project) {
      projectsByName.set(project.name, project);
    },
  } as ProjectRepository;
  const versionRepo = {
    async get(projectName: string, versionName: string) {
      return (
        stored.find((v) => v.projectName === projectName && v.versionName === versionName) ?? null
      );
    },
    async list(projectName: string) {
      return stored.filter((v) => v.projectName === projectName);
    },
    async create(version: Version) {
      stored.push(version);
    },
  } as VersionRepository;
  return { projectRepo, versionRepo, stored, projectsByName };
}

function makeClone(repos: ReturnType<typeof makeRepos>) {
  return composeCloneProject({
    projects: repos.projectRepo,
    versions: repos.versionRepo,
    refs: RESOLVING_REFS,
    cipher: secretCipher,
  });
}

const INPUT = { sourceName: "source", name: "copy", displayName: "Copy", userEmail: CLONER };

describe("cloneProject", () => {
  it("copies the published version as an unpublished version \"1\" owned by the cloner", async () => {
    const repos = makeRepos(
      [sourceProject({ publishedVersion: "1" })],
      [sourceVersion(), sourceVersion({ versionName: "2", systemPrompt: "newer", createdAt: "2026-01-03T00:00:00.000Z" })],
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
    expect(project.publishedVersion).toBeUndefined();
    const copied = repos.stored.filter((v) => v.projectName === "copy");
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatchObject({
      versionName: "1",
      systemPrompt: "be helpful",
      model: "openai/gpt-5-mini",
      skillList: ["summarize"],
      subagentList: [{ name: "helper", type: "local" }],
      maxTurn: 5,
    });
  });

  it("drops MCP header overrides but keeps the binding and its tool selection", async () => {
    const repos = makeRepos([sourceProject({ publishedVersion: "1" })], [sourceVersion()]);
    await makeClone(repos)(INPUT);

    const [binding] = repos.stored.filter((v) => v.projectName === "copy")[0]!.mcpList;
    expect(binding).toEqual({ name: "docs", tools: ["search"] });
  });

  it("copies the newest version when nothing is published", async () => {
    const repos = makeRepos(
      [sourceProject()],
      [sourceVersion(), sourceVersion({ versionName: "2", systemPrompt: "newer", createdAt: "2026-01-03T00:00:00.000Z" })],
    );
    await makeClone(repos)(INPUT);

    expect(repos.stored.filter((v) => v.projectName === "copy")[0]!.systemPrompt).toBe("newer");
  });

  it("creates a versionless clone of a versionless source, with nothing to warn about", async () => {
    const repos = makeRepos([sourceProject()], []);
    const { project, warning } = await makeClone(repos)(INPUT);

    expect(project.name).toBe("copy");
    expect(warning).toBeUndefined();
    expect(repos.stored).toHaveLength(0);
  });

  it("says what was lost when the version cannot be copied", async () => {
    const repos = makeRepos([sourceProject()], [sourceVersion()]);
    const clone = composeCloneProject({
      projects: repos.projectRepo,
      versions: repos.versionRepo,
      // Every reference the copied version names fails to resolve.
      refs: {
        skills: { get: async () => null },
        mcps: { get: async () => null },
        externalAgents: { get: async () => null },
        projects: { get: async () => null },
      } as unknown as VersionRefRepos,
      cipher: secretCipher,
    });

    const { project, warning } = await clone(INPUT);

    expect(project.name).toBe("copy");
    expect(warning).toContain("could not be copied");
    expect(repos.stored.filter((v) => v.projectName === "copy")).toHaveLength(0);
  });

  it("clones a private source as a private project with an empty invite list", async () => {
    const repos = makeRepos(
      [sourceProject({ visibility: "private", memberEmails: [CLONER, "other@x.com"] })],
      [sourceVersion()],
    );
    const { project } = await makeClone(repos)(INPUT);

    expect(project.visibility).toBe("private");
    expect(project.memberEmails).toBeUndefined();
  });

  it("refuses a private source the caller cannot access", async () => {
    const repos = makeRepos([sourceProject({ visibility: "private" })], [sourceVersion()]);
    await expect(makeClone(repos)(INPUT)).rejects.toBeInstanceOf(ForbiddenError);
    expect(repos.projectsByName.has("copy")).toBe(false);
  });

  it("clones a private source for an invited member", async () => {
    const repos = makeRepos(
      [sourceProject({ visibility: "private", memberEmails: [CLONER] })],
      [sourceVersion()],
    );
    await expect(makeClone(repos)(INPUT)).resolves.toMatchObject({ project: { name: "copy" } });
  });

  it("refuses a target name that already exists", async () => {
    const repos = makeRepos(
      [sourceProject(), sourceProject({ name: "copy" })],
      [sourceVersion()],
    );
    await expect(makeClone(repos)(INPUT)).rejects.toBeInstanceOf(ConflictError);
  });
});
